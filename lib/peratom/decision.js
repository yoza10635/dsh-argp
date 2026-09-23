/**
 * PeratomCompressor 引擎侧确定性规划模块（P5 结构重构 Wave 3 第 5 步，C 报告 §4 B 表）。
 *
 * 从 1,520 行 `compressor.ts`（God Class）拆出的**纯函数**侧：
 *  - 防御性 JSON 提取（extractJson，spike 32 同款）；
 *  - 模型输出信任边界（normalizeDecision：seq/quotes/level/text 全字段校验，异形丢弃）；
 *  - 引擎侧规划（planReplacements：模型输出 → 落盘动作，全部策略裁决在引擎侧）
 *    + 副本载荷构造（userCopyPayload / toolCopyPayload）。
 *
 * 全部为纯函数（只依赖入参 + 少量 config），无需宿主接口。依赖方向：
 *   compressor-types（叶）← decision ← flush ← compressor（组合根）。
 * 本模块不 import 任何 peratom 运行时类，仅依赖叶子/纯函数模块（split/gate/
 * token-ontology/types）与 dsh-llm 的 createUserMessage。
 *
 * 行为逐字节不变：函数体逻辑逐字保留，仅搬家。
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { ARG_NS } from './types.js';
import { buildDialogText, buildInfoText, resolveSplit } from './split.js';
import { fidelityGuard } from './gate.js';
import { DEFAULT_HLS_ROI_THRESHOLD, hlsRepairEconomics, repairWithTrailer } from '../token-ontology.js';
// ---------------------------------------------------------------------------
// 结构化输出契约（JSON Schema 强制 + 防御性提取双保险）
// ---------------------------------------------------------------------------
/**
 * 防御性 JSON 提取（spike 32 extractJson 原样复刻）：剥 <think>、剥代码围栏、
 * 从最后一个 } 向前找配对 {。response_format 失效的端点上兜底。
 */
export function extractJson(raw) {
    const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/g, '');
    const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(cleaned);
    const text = (fenced?.[1] ?? cleaned).trim();
    try {
        return JSON.parse(text);
    }
    catch { /* fall through */ }
    const last = text.lastIndexOf('}');
    if (last > 0) {
        for (let first = text.lastIndexOf('{', last - 1); first >= 0; first = text.lastIndexOf('{', first - 1)) {
            try {
                return JSON.parse(text.slice(first, last + 1));
            }
            catch { /* keep scanning */ }
        }
    }
    return undefined;
}
/** 模型输出 → CompressDecision（信任边界：seq/quotes/level/text 全字段校验，异形丢弃）。 */
export function normalizeDecision(cand) {
    if (cand === null || typeof cand !== 'object')
        return null;
    const o = cand;
    if (!Array.isArray(o.splits) && !Array.isArray(o.tools))
        return null;
    const splits = [];
    const tools = [];
    for (const item of Array.isArray(o.splits) ? o.splits : []) {
        const seq = item?.seq;
        const quotes = item?.quotes;
        if (typeof seq !== 'number' || !Number.isInteger(seq))
            continue;
        if (!Array.isArray(quotes))
            continue;
        const rawLevel = item?.infoLevel;
        // 档位白名单；缺省/异形 → undefined（planReplacements 回退逐字，安全方向）。
        const infoLevel = rawLevel === 'summary' || rawLevel === 'extract' || rawLevel === 'false' ? rawLevel : undefined;
        const rawText = item?.infoText;
        // summary/extract 必须带非空压缩文本，否则弃档（回退逐字）；false/缺省允许空串。
        const infoText = typeof rawText === 'string'
            && (infoLevel === undefined || infoLevel === 'false' || rawText.length > 0)
            ? rawText
            : undefined;
        splits.push({ seq, quotes: quotes.filter((q) => typeof q === 'string'), infoLevel, infoText });
    }
    for (const item of Array.isArray(o.tools) ? o.tools : []) {
        const t = item;
        if (typeof t?.seq !== 'number' || !Number.isInteger(t.seq))
            continue;
        // 显式"不压"信号（设计对称：与 info 同级）。text 可空，planReplacements 直接跳过。
        if (t.level === 'false') {
            tools.push({ seq: t.seq, level: 'false', text: typeof t.text === 'string' ? t.text : '' });
            continue;
        }
        if (t.level !== 'extract' && t.level !== 'summary')
            continue;
        if (typeof t.text !== 'string' || t.text.length === 0)
            continue;
        tools.push({ seq: t.seq, level: t.level, text: t.text });
    }
    return { splits, tools };
}
/**
 * 从 user/message 事件提取 image/file 附件块（U-info 副本保留用；含 offloaded 标记）。
 * 非 user 事件 / 无 content / seq 不匹配 → 空数组（安全回退 = 现状纯文本副本）。
 */
export function attachmentBlocksOf(event, expectedSeq) {
    if (event === undefined || event.type !== 'user/message')
        return [];
    if (expectedSeq !== undefined && event.seq !== expectedSeq)
        return [];
    const content = event.data?.message?.content;
    if (!Array.isArray(content))
        return [];
    return content.filter(b => b.type === 'image' || b.type === 'file');
}
/**
 * user/message 副本载荷：argp 署名（宿主 0.1.7 去 `plugin` 化，见 llm-source-augment.d.ts）；
 * meta 存在时挂 data[ARG_NS]（U-info 标记 + summary）。
 *
 * 附件保留（1.7.0）：`attachments` 为原消息的 image/file 块。原消息带附件时，
 * U-info 副本 = 压缩文本 + 原样附件块——LLM 提取只作用于文本（附件在 wire 侧是
 * `[image omitted]` 占位，LLM 提取不了），附件原样留在副本里，避免被纯文本副本
 * 从模型上下文静默丢掉。宿主对 user/message 的 surface replace 无 content 级约束
 * （worker.cjs `planSurfaceEvent` 只校验 range+provenance），带附件块的副本合法。
 */
export function userCopyPayload(text, meta, attachments) {
    const content = [{ type: 'text', text }, ...(attachments ?? [])];
    const msg = createUserMessage({
        content,
        source: { kind: 'argp' },
    });
    if (meta === undefined)
        return msg;
    return { ...msg, [ARG_NS]: { info: true, sourceSeq: meta.sourceSeq, summary: meta.summary } };
}
/**
 * tool/result replace 副本载荷。dsh-session 硬约束："tool/result surface replacement
 * may change only content"——替换数据与原文除 message.content[0].content 外必须逐键
 * 深度相等，因此**不能**携带 data[ARG_NS] 元数据（多余键即拒绝）。
 * summary 语义由副本正文本身承载；P3 recall_summary 对无 data[ARG_NS].summary 的节点
 * 按设计降级返回 extract 副本文本，信息无损。防再压缩由版本链索引天然兜住：
 * 原文与副本同 (tool|args) 键 → 计数 ≥2 → 双双硬排除。
 */
/**
 * tool/result 压缩副本的头部标记（v1.6.1）：`[已压缩-摘取 seq=N]` / `[已压缩-摘要 seq=N]`。
 *
 * **为什么必须存在**：副本在 LLM 侧与真实工具输出不可辨。extract 档的 text 按 prompt
 * 契约是原文**逐字**片段（`prompt.ts` PROMPT_RULES「逐字完整拷贝」），模型无从判断它
 * 是片段还是完整输出；summary 档的 text 是概括，模型可能把概括措辞当原文引用——
 * 而 `argp-cites` 协议要求「copy verbatim the first 10-20 words」，引用压缩态措辞
 * 会指向日志里不存在的串（引用图错边）。分档标记顺带给出「这段措辞是原文还是改写」
 * 的信号，成本与单一标记等同（同字数）。
 *
 * **为什么带 seq**：seq 是日志内部序号，模型在 tool/result 消息里看不到它。不带 seq，
 * 即便 system 契约写了「用 recall_detail 找回」，模型也无参数可调 ⇒ 召回通路实际是断的。
 * 图剪墓碑把 seq 写进正文（`[elided seq=N..M]`，`prune-tx.ts`）正是同一理由。
 * N 取**原事件 seq**（= `action.seq`）：recall 工具索引 append-only 日志，原文事件
 * 仍在其中，传原 seq 即取回原文。
 *
 * **召回指引不写在这里**：每原子重复一段指引纯属浪费上下文，统一由 system 提示词
 * 的 `argp-recall-zoom` / `argp-contract` 静态段一次性说明（静态 = 不破坏前缀缓存）。
 *
 * ⚠️ 自指陷阱：本字面量会进入语料正文。语料侧统计（压缩计数 / 保真统计）须按
 * `^\[已压缩-(摘取|摘要) seq=\d+\]\n` 剥离后再算，否则重复 `[restored]`/`cites`
 * 字面量假阳性的老问题。
 */
export function toolCopyMarkerText(level, seq) {
    return `[已压缩-${level === 'extract' ? '摘取' : '摘要'} seq=${seq}]`;
}
/** 剥离副本头部标记的正则（语料侧审计 / 测试共用；只匹配行首单行标记）。 */
export const TOOL_COPY_MARKER_RE = /^\[已压缩-(?:摘取|摘要) seq=\d+\]\n/;
/**
 * tool/result 副本载荷（双形状，宿主 0.1.7 去 plugin 化 + tool 一等消息）：
 *  - **V4**（0.1.7）：`message.role === 'tool'`，`toolCallId`/`isError` 在**顶层**，
 *    `content` 是 `ContentBlock[]`（text block）⇒ 只把 `content` 换成单 text block，
 *    顶层 `role`/`source`/`toolCallId`/`isError` 经对象展开原样保留（宿主
 *    `assertToolResultRewrite` 只许改 inner text，顶层身份字段不可动）。
 *  - **V3**（≤0.1.6）：`message.role === 'user'`，`content[0]` 是内嵌 `tool-result`
 *    block（`toolCallId`/`isError` 在 block 内）⇒ 只改该 block 的 inner text。
 * 两形态都保留原 `data` 其余字段（turn/step 等）与 message 其余字段（id 等）。
 */
function toolCopyPayload(origData, text) {
    const d = origData;
    const msg = d?.message;
    if (msg === undefined || typeof msg !== 'object') {
        throw new Error('peratom-compressor: cannot rewrite tool/result without a message');
    }
    // V4（0.1.7）：role:'tool' 一等消息 ⇒ content 换单 text block，顶层身份字段经展开保留。
    if (msg.role === 'tool') {
        return {
            ...d,
            message: { ...msg, content: [{ type: 'text', text }] },
        };
    }
    // V3（≤0.1.6）：role:'user' 内嵌 tool-result block ⇒ 只改该 block 的 inner text。
    const block = msg.content?.[0];
    if (block === undefined || typeof block !== 'object') {
        throw new Error('peratom-compressor: cannot rewrite tool/result without a content block');
    }
    return {
        ...d,
        message: {
            ...msg,
            content: [{ ...block, content: [{ type: 'text', text }] }],
        },
    };
}
/**
 * 引擎侧规划：模型输出过信任边界（seq 必须命中本轮收集集，先到先得去重），
 * 用户消息过 resolveSplit 全套保守策略（定位失败回退 dialog / 覆盖率翻转 / 空隙归 info）。
 * 返回落盘步骤序列；steps 为空 = 本轮无可落地动作（不开发务括号）。
 */
export function planReplacements(collect, decision, events, opts = {}) {
    // 独立调用方缺省 'off'（v1.1 行为）；类实例化路径传生产缺省 'trailer'。
    const hlsMode = opts.hlsMode ?? 'off';
    const hlsRoiThreshold = opts.hlsRoiThreshold ?? DEFAULT_HLS_ROI_THRESHOLD;
    // 头部标记开关：独立调用方缺省 'off'（v1.6 行为逐字节不变）；生产路径显式传 'on'。
    const markerOn = opts.marker === 'on';
    const userBySeq = new Map(collect.userLong.map(u => [u.seq, u]));
    const toolBySeq = new Map(collect.toolResults.map(t => [t.seq, t]));
    const steps = [];
    let replaces = 0;
    let skippedFallbackDialog = 0;
    let skippedFidelity = 0;
    let skippedFalse = 0;
    let skippedNoopGain = 0;
    const fidelityMissing = [];
    const summaryDropped = [];
    const restoredByGuard = [];
    let hlsRepairs = 0;
    let hlsRoiSkipped = 0;
    let anomalies = 0;
    const seenUserSeqs = new Set();
    for (const split of decision.splits) {
        const atom = userBySeq.get(split.seq);
        if (atom === undefined) {
            anomalies += 1;
            continue;
        }
        if (seenUserSeqs.has(split.seq)) {
            anomalies += 1;
            continue;
        }
        seenUserSeqs.add(split.seq);
        const res = resolveSplit(atom.text, split.quotes);
        if (res.kind === 'split') {
            const dialogText = buildDialogText(atom.text, res.dialogSpans);
            const verbatimInfo = buildInfoText(atom.text, res.infoSpans);
            // info 压缩（设计 §10 决策 1 补实现）：summary/extract 用模型压缩文本；false/缺省回退逐字切片。
            // guard 的 original 取 info 片段而非整条 user——dialog 里的路径/错误码不要求出现在 info 副本中。
            let infoText = verbatimInfo;
            if (split.infoLevel === 'summary' || split.infoLevel === 'extract') {
                const candidate = split.infoText ?? '';
                if (candidate.length > 0) {
                    const guard = fidelityGuard(verbatimInfo, candidate);
                    if (!guard.ok) {
                        if (split.infoLevel === 'summary') {
                            // summary 审计放行：概括天然丢精确串，缺失清单入账供审核（与 tool summary 同档纪律）。
                            summaryDropped.push(...guard.missing);
                            infoText = candidate;
                        }
                        else if (hlsMode === 'trailer') {
                            // HLS 修复档（v1.2.0 组件 B）：尾注补全缺失硬 token——保真由构造
                            // （fidelityGuard 平凡通过 = 构造性断言；I-B1/I-B3）。
                            // 经济学门控（θ=1）：修复后不划算（ROI < θ）→ 退回原文保面（v1.1 行为）。
                            const econ = hlsRepairEconomics(verbatimInfo.length, candidate.length, guard.missing, hlsRoiThreshold);
                            if (!econ.accept) {
                                hlsRoiSkipped += 1;
                                skippedFidelity += 1;
                                fidelityMissing.push(...guard.missing);
                            }
                            else {
                                const repaired = repairWithTrailer(candidate, guard.missing);
                                if (fidelityGuard(verbatimInfo, repaired).ok) {
                                    hlsRepairs += 1;
                                    restoredByGuard.push(...guard.missing);
                                    infoText = repaired;
                                }
                                else {
                                    // 构造性断言失败 = bug 信号：回退原文保面（保守方向）。
                                    skippedFidelity += 1;
                                    fidelityMissing.push(...guard.missing);
                                }
                            }
                        }
                        else {
                            // extract 硬拒（v1.1）：缺任一高信号 token 即回退逐字（原文保面，错误方向只往"少压"错）。
                            skippedFidelity += 1;
                            fidelityMissing.push(...guard.missing);
                        }
                    }
                    else {
                        infoText = candidate;
                    }
                }
            }
            steps.push({
                kind: 'replace',
                type: 'user/message',
                at: atom.seq,
                data: userCopyPayload(dialogText, undefined, attachmentBlocksOf(events[atom.seq], atom.seq)),
                sourceEventSeqs: [atom.seq],
            });
            replaces += 1;
            // U-info append：tail-only 管线（flush 窗口内恰落在当轮尾部）；原文天然留日志。
            // 单档（§10 决策 7）：surface 放压缩态文本，data[ARG_NS].summary 存同文本——
            // recall_summary 直接可用；recall_detail 从 append-only 日志还原原文。
            steps.push({
                kind: 'append',
                type: 'user/message',
                at: atom.seq,
                data: userCopyPayload(infoText, { sourceSeq: atom.seq, summary: infoText }, attachmentBlocksOf(events[atom.seq], atom.seq)),
                sourceEventSeqs: [atom.seq],
            });
        }
        else if (res.kind === 'info-only') {
            // 零标注退化：整条 U-info 单事件 replace（纯资料消息的自然情形，非特判）。
            steps.push({
                kind: 'replace',
                type: 'user/message',
                at: atom.seq,
                data: userCopyPayload(atom.text, { sourceSeq: atom.seq, summary: atom.text }, attachmentBlocksOf(events[atom.seq], atom.seq)),
                sourceEventSeqs: [atom.seq],
            });
            replaces += 1;
        }
        else {
            // fallback-dialog / unsplit（覆盖率翻转、无余量、空消息）：放弃拆分，整条保留 dialog。
            skippedFallbackDialog += 1;
        }
    }
    const origDataBySeq = new Map();
    for (const event of events) {
        if (event === undefined)
            continue; // 稀疏数组空洞防御（真实 sessionEvents 稠密；seq 索引数组理论上可有空洞）
        if (event.type === 'tool/result')
            origDataBySeq.set(event.seq, event.data);
    }
    const seenToolSeqs = new Set();
    for (const action of decision.tools) {
        if (action.level === 'false') {
            skippedFalse += 1;
            continue;
        } // 显式"不压"：原子保原文，不 emit replace
        const atom = toolBySeq.get(action.seq);
        if (atom === undefined) {
            anomalies += 1;
            continue;
        }
        if (seenToolSeqs.has(action.seq)) {
            anomalies += 1;
            continue;
        }
        seenToolSeqs.add(action.seq);
        // no-op 守卫（spike 37 两次跑批实锤）：模型对源码类 tool-result 全文照抄（2.5K 模块
        // 原样返回）→ fidelityGuard 平凡通过（token 全在）→ 零收益 replace 白花 surface 换代、
        // 污染逐原子审计。副本收益 ≤5%（含持平/变长）视同显式 false：原文保面 + 计数入账
        //（对齐 87c66de「拿不准选 false」的设计意图）。用户路径不受此守卫——'info-only' 的
        // 同文 replace 承载 data[ARG_NS] 元数据，有结构作用，不能省。
        // 头部标记（v1.6.1）：**先算长度再过守卫**——按落地后的真实长度判收益。no-op 守卫
        // 原本只在模型输出上判（`action.text`），看不见标记开销 ⇒ 会出现"加了标记反而与原文
        // 持平/变长"的白压。计入后这类原子自动退回原文保面（与收益归零同向，错误方向仍是少压）。
        const marker = markerOn ? toolCopyMarkerText(action.level, action.seq) + '\n' : '';
        if (action.text.length + marker.length >= atom.text.length * 0.95) {
            skippedNoopGain += 1;
            continue;
        }
        // 保真守卫（spike 34 驱动）：原文的高信号 token 必须在副本里 verbatim 存活。
        // level-aware 分级（spike36 复盘驱动）：summary 是模型自选的概括档，概括天然
        // 会丢精确串，硬拒会让该档位永远不可用——审计式放行：缺失清单入账
        // summaryDropped，供 LLM 审核 / 人工审核事后评判。
        // v1.2.0 HLS 修复档（组件 B，hlsMode='trailer'）：extract 缺 token 不再整条
        // 丢弃（收益全损）——守卫机械补全缺失硬 token（尾注 `[restored]`），
        // 硬 token 保真由构造、prose 损失受控、缺失清单入 restoredByGuard 台账；
        // hlsMode='off' 退回 v1.1 硬拒（原文保面，错误方向只往"少压"错）。
        const guard = fidelityGuard(atom.text, action.text);
        let text = action.text;
        if (!guard.ok) {
            if (action.level === 'summary') {
                summaryDropped.push(...guard.missing);
            }
            else if (hlsMode === 'trailer') {
                // 经济学门控（θ=1）：修复后不划算（ROI < θ，典型 = 修复文本 ≥ 原文）→
                // 原样退回 v1.1 硬拒（原文保面）。门控拒收与构造性失败同列 skippedFidelity，
                // 单列 hlsRoiSkipped 以度量代价盲区间频率。
                const econ = hlsRepairEconomics(atom.text.length, action.text.length, guard.missing, hlsRoiThreshold);
                if (!econ.accept) {
                    hlsRoiSkipped += 1;
                    skippedFidelity += 1;
                    fidelityMissing.push(...guard.missing);
                    continue;
                }
                const repaired = repairWithTrailer(action.text, guard.missing);
                if (fidelityGuard(atom.text, repaired).ok) {
                    hlsRepairs += 1;
                    restoredByGuard.push(...guard.missing);
                    text = repaired;
                }
                else {
                    // 构造性断言失败 = bug 信号：回退原文保面（保守方向）。
                    skippedFidelity += 1;
                    fidelityMissing.push(...guard.missing);
                    continue;
                }
            }
            else {
                skippedFidelity += 1;
                fidelityMissing.push(...guard.missing);
                continue;
            }
        }
        steps.push({
            kind: 'replace',
            type: 'tool/result',
            at: action.seq,
            // 标记只在**最终落地文本**上拼：fidelityGuard 与 HLS 尾注修复都跑在未加标记的
            // 模型输出上（保真语义逐字不变，HLS 尾注仍在文本尾部，二者互不干扰）。
            data: toolCopyPayload(origDataBySeq.get(action.seq), marker + text),
            sourceEventSeqs: [action.seq],
        });
        replaces += 1;
    }
    return { steps, replaces, skippedFallbackDialog, skippedFidelity, skippedFalse, skippedNoopGain, fidelityMissing, summaryDropped, hlsRepairs, restoredByGuard, hlsRoiSkipped, anomalies };
}
