/**
 * PeratomCompressor（Stage-1，plan P1）：eager 轮末熵降管线。
 *
 * 宿主身份（plan §0）：**普通 cordis 服务，非 ctx.compaction 服务位**——Stage-2 的
 * ArgpGraphEngine 独占 compaction 位，本服务走事件钩子，失败隔离免费获得。
 *
 * 触发与发射的两段式设计（对齐 dsh-session 不变量）：
 *  - `agent/status: idle` 钩子触发（spike 06 idle 判定口径）：此刻当轮已闭
 *    （agent-loop kick() 在 turn/end 之后的 finally 才 setPhase idle）。收集当轮原子 +
 *    发起 LLM 调用（网络等待在轮外，不阻塞任何 waterfall），结果暂存 pending 队列。
 *  - 事务发射推迟到下一次 `agent/pre-step`（新轮已开、其 user/message 尚未入日志——
 *    loop 先跑 preStep 再落盘消息）。原因：dsh-session invariant 规定 tool/result 的
 *    surface replace 是"durable turn work"，只允许在 open turn 内追加；idle 时 openTurn=null。
 *    推迟发射不损缓存语义：前 N-1 轮前缀字节不变，替换发生在下一次请求组装之前。
 *  - **"轮外"只在调用先于下一条消息返回时成立**（2026-09-21 修）：若调用仍在飞而用户
 *    已发下一条消息，新轮首个 pre-step 无条目可发射 ⇒ 事务落到新轮**中途**（真环境实证：
 *    跨进程 resume 的 pass 晚 6 步落盘，前 6 步跑在未压缩上下文上 + 中途换 surface 断
 *    KV）。故 pre-step **有界等待**在飞 pass（`flushWaitMs`，默认 180s；超时告警后放行
 *    ——事务顺延到后续窗口，即旧行为），使"下一个 user message 等待"成为确定性语义。
 *  - 防重复处理：按 (session, turn) 记**压缩水位**（见 passWatermark）——已规划过的
 *    前缀不再入候选，重复 idle / pre-step 因窗口为空而幂等短路；成功 pass 之后
 *    同轮新增内容仍可再压（2026-09-21 起，替代原"轮级一次性"记账）。
 *  - `compressCurrentTurn(session)` 公开入口：立即收集+调用+发射（P4 溢出三步路径②与单测用），
 *    绕过两段式延迟。
 *
 * 单次调用覆盖当轮全部可压原子（user quotes 拆分 + tool extract/summary），OpenAI 兼容
 * fetch + JSON Schema 强制输出（复用 spike 30/32 模式；response_format 被端点拒绝时
 * 自动降级为裸 prompt + 防御性 JSON 提取——spike 32 extractJson 同款）。
 *
 * 无再压缩路径（决策⑦）：collect 只取"原始态"原子——已是 U-info/replace 副本的 seq 直接跳过；
 * 版本链成员硬排除（gate 决策序①）；被中断轮次整轮排除（filterInterruptedAtoms 内嵌）。
 */
import { randomUUID } from 'node:crypto';
import { compactCheckpointSource, CompactionId } from '@deepseek-ai/dsh-compaction';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { asSeq, asSeqs, sessionEvents } from '../log-access.js';
import { ARG_NS, SPLIT_THRESHOLD_CHARS } from './types.js';
import { completeViaDshLlm } from './llm-adapter.js';
import { autoDshLlmSpec } from './llm-adapter.js';
import { serializeWireMessages, serializeWireTools } from './llm-adapter.js';
import { buildDialogText, buildInfoText, resolveSplit } from './split.js';
import { DEFAULT_SMALL_RESULT_CHARS, buildToolNameIndex, buildVersionChainIndex, collectInterruptedTurns, fidelityGuard, filterInterruptedAtoms, projectSurfaceText, rNeedCompress, turnCompressible, userIsLong, } from './gate.js';
import { DEFAULT_HLS_ROI_THRESHOLD, hlsRepairEconomics, repairWithTrailer } from '../token-ontology.js';
/** 插件署名（dialog replace / U-info append 副本的 message.source.plugin）。 */
const PLUGIN_NAME = 'dsh-argp';
/**
 * 缺省端点解析：ARGP_MODEL_SOURCE=qwen-local → QWEN_BASE/QWEN_MODEL（本地推理）；
 * 否则 DeepSeek 生产端点 + DEEPSEEK_API_KEY。apiKey 缺失 → disabled（静默跳过，
 * 开发/离线环境零网络副作用）。
 */
export function defaultEndpoint(env = process.env) {
    if (env['ARGP_MODEL_SOURCE'] === 'qwen-local') {
        return {
            endpoint: (env['QWEN_BASE'] ?? 'http://127.0.0.1:8080/v1') + '/chat/completions',
            model: env['QWEN_MODEL'] ?? 'Qwen3.8-27B',
            apiKey: env['DEEPSEEK_API_KEY'] ?? 'dummy-local',
        };
    }
    const apiKey = env['DEEPSEEK_API_KEY'];
    if (apiKey === undefined || apiKey === '')
        return null;
    return {
        endpoint: env['DEEPSEEK_BASE'] !== undefined ? env['DEEPSEEK_BASE'] + '/chat/completions' : 'https://api.deepseek.com/chat/completions',
        model: env['DEEPSEEK_MODEL'] ?? 'deepseek-v4-flash',
        apiKey,
    };
}
const OUTPUT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['splits', 'tools'],
    properties: {
        splits: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['seq', 'quotes', 'infoLevel', 'infoText'],
                properties: {
                    seq: { type: 'integer' },
                    quotes: { type: 'array', items: { type: 'string' } },
                    infoLevel: { type: 'string', enum: ['false', 'summary', 'extract'] },
                    infoText: { type: 'string' },
                },
            },
        },
        tools: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['seq', 'level', 'text'],
                properties: {
                    seq: { type: 'integer' },
                    level: { type: 'string', enum: ['extract', 'summary', 'false'] },
                    text: { type: 'string' },
                },
            },
        },
    },
};
/**
 * 防御性 JSON 提取（spike 32 extractJson 原样复刻）：剥 <think>、剥代码围栏、
 * 从最后一个 } 向前找配对 {。response_format 失效的端点上兜底。
 */
function extractJson(raw) {
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
/** user/message 副本载荷：plugin 署名；meta 存在时挂 data[ARG_NS]（U-info 标记 + summary）。 */
function userCopyPayload(text, meta) {
    const msg = createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'plugin', plugin: PLUGIN_NAME },
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
function toolCopyPayload(origData, text) {
    const d = origData;
    const block = d?.message?.content?.[0];
    if (block === undefined || typeof block !== 'object') {
        throw new Error('peratom-compressor: cannot rewrite tool/result without a content block');
    }
    return {
        ...d,
        message: {
            ...d?.message,
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
                data: userCopyPayload(dialogText),
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
                data: userCopyPayload(infoText, { sourceSeq: atom.seq, summary: infoText }),
                sourceEventSeqs: [atom.seq],
            });
        }
        else if (res.kind === 'info-only') {
            // 零标注退化：整条 U-info 单事件 replace（纯资料消息的自然情形，非特判）。
            steps.push({
                kind: 'replace',
                type: 'user/message',
                at: atom.seq,
                data: userCopyPayload(atom.text, { sourceSeq: atom.seq, summary: atom.text }),
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
        if (action.text.length >= atom.text.length * 0.95) {
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
            data: toolCopyPayload(origDataBySeq.get(action.seq), text),
            sourceEventSeqs: [action.seq],
        });
        replaces += 1;
    }
    return { steps, replaces, skippedFallbackDialog, skippedFidelity, skippedFalse, skippedNoopGain, fidelityMissing, summaryDropped, hlsRepairs, restoredByGuard, hlsRoiSkipped, anomalies };
}
// ---------------------------------------------------------------------------
// Prompt（单次调用覆盖当轮全部可压原子；规则前言吸收 P0 三层对冲 + 已知债务 6 修正）
// ---------------------------------------------------------------------------
const PROMPT_RULES = [
    '你是会话压缩器。输入列出本轮全部可压缩原子，你的输出决定它们的压缩形态。',
    '',
    '## 用户长消息拆分（splits）',
    '- 把每条用户消息划分为指令(dialog)片段与资料(info)余量：指令=用户要求做的事、提出的问题、约束或偏好（包括"注意X""别动Y""用Z"限定语）；资料=用户粘贴/附带的一切非指令内容，例如日志、代码、配置、报错、外部评审/方案、文献原文、说明、表格数据、文档引用等。',
    '- quotes 数组逐字抄写每段连续指令原文：必须与原文完全一致（空白、换行、标点、大小写、全角半角、emoji），禁止改写、翻译、增删任何字符。',
    '- 片段按原文出现顺序排列；同一段连续指令不要拆成多段，不相邻的指令不要合并成一段。',
    '- 保守纪律：任何可能包含指令语义的片段都必须抄入 quotes——错误方向只允许往 dialog 错；存档/转发类引导语算资料。',
    '- 未抄写的部分视为资料，会被聚合成可压缩副本。',
    '- infoLevel 决定资料的压缩方式：false=资料很短或无可压空间（infoText 留空，保留原文）；summary=叙述性资料（外部评审、方案、讨论记录、说明）用简洁概括，概括中保留出现的函数名、版本号、API、路径、错误码等精确串；extract=含精确串的资料（shell 报错、日志行、代码片段）逐字保留有用部分、丢弃噪声，infoText 必须与原文逐字一致（空白、换行、标点、大小写全部原样），禁止改写。',
    '- 档位判断：外部 AI 的评审/方案/记录、长段说明 → summary；shell 报错、含错误码/路径/行号的内容 → extract；短小或无冗余 → false。',
    '- infoText 必填：summary/extract 时写入压缩结果；false 时留空字符串。',
    '',
    '## 工具结果压缩（tools）',
    '- 对每个原子做三选一判断（extract / summary / false），把判断与压缩内容写进同一条 {"seq","level","text"}：',
    '- 判断为摘取（level="extract"）：内容含结构化数据或精确串（日志行、配置、代码、命令输出），关键信息依赖原文措辞 → text 必须是所选原文片段的逐字完整拷贝——与原文完全一致（空白、换行、标点、大小写、全角半角、emoji 全部原样），禁止改写、翻译、增删、合并或重新组织任何字符；未选中的行视为噪声直接丢弃。',
    '- 判断为摘要（level="summary"）：内容是冗长叙述性文本、概括不损失关键信息 → text 用简洁概括替换全文；若原文仍有个别必须精确保留的串（错误码、标识符、路径等），把它们原样写进概括文本。保真口径（对外契约）：summary 档只保证结构化承重 token（URL/路径/file:line/UUID/哈希/key=value 等）逐字存活，散文级引用不保证逐字——概括改写散文是本职，不是缺陷。',
    '- 判断为不压（level="false"）：原子全是关键内容、无可丢弃的噪声（典型如完整源码模块、无任何冗余的文本）→ 保留原文，text 留空字符串，不要输出压缩副本。',
    '- 档位由你按每个原子的内容性质自行判断，不必统一。判断标准：确有可丢弃的噪声/冗余时才选 extract 或 summary（text 必须比原文显著缩短）；没有可压空间或拿不准时，显式选 false（从输出里省略该 seq 也等价）。禁止全文照抄一遍（如 level=extract 且 text≈原文），那既浪费 token 又无压缩收益。',
    '',
    '## 输出',
    '只输出一个 JSON 对象：{"splits":[{"seq":<整数>,"quotes":["…"]}],"tools":[{"seq":<整数>,"level":"extract"|"summary"|"false","text":"…"}]}',
    '- seq 原样返回输入给出的值；不需要压缩的原子不要出现在输出里（视为保原文）。',
].join('\n');
function buildPrompt(collect) {
    const atoms = [];
    for (const u of collect.userLong) {
        atoms.push(`<ATOM seq=${u.seq} kind="user-long">\n${u.text}\n</ATOM>`);
    }
    for (const t of collect.toolResults) {
        atoms.push(`<ATOM seq=${t.seq} kind="tool-result">\n${t.text}\n</ATOM>`);
    }
    return PROMPT_RULES + '\n\n' + atoms.join('\n\n');
}
/**
 * A 形态（设计文档 §4 tail-only 语义）：压缩调用站在 agent 链延长线上——
 * `[...agent 当前 deriveMessages() 的 wire 渲染, {user: 压缩指令}]`。
 *
 * ⚠️ 复用率实测（2026-09-19 record2 + .tmp/kv-a2-diag5 隔离实验，长历史）：
 * Qwen3 模板的 reasoning 渲染受"最后一条 user 位置"门控——末尾是 user 指令时，
 * 最后一条 user **之后**的 assistant reasoning 在 agent 上一发（P_last）里全渲染、
 * 在本请求里全剥离 ⇒ 前缀从该处起分叉。长历史（轮内 reasoning 多）实测 LCP 仅 30.3%
 * （pt:false）/ 12.7%（pt:true 反而更差：把 P_last 剥掉的跨轮 reasoning 又渲染回来）；
 * 短历史（turn1 末，reasoning 极少）才 ≈100%。⇒ **A 形态的真实复用率是历史长度依赖的**，
 * 此前"完全复用 / LCP=100%"的注释与结论均基于短历史假象，已作废。
 * 若要长历史下接近完全复用，需 A-4（尾部指令用 assistant 承载，实测 LCP=100%）
 * 或 A-3（前缀截断到最后一条 user，自身复用率 87.1%，compaction-basic 同款形态）。
 * 本函数在 A 形态下仍强制 `preserve_thinking:true`（维持既有行为），待形态拍板后统一调整。
 */
async function postChat(fetchImpl, ep, prompt, timeoutMs, useJsonSchema, chatTemplateKwargs, 
/** A 形态前缀（serializeWireMessages 产物）；缺省 = C 形态独立 one-shot。 */
contextWire, 
/** A 形态 tools 透传（requestHeader().tools 的 wire 渲染）。 */
contextTools, 
/** 输出 cap（token）。压缩输出是 JSON plan，通常几百 token；设小 cap 给 prompt 让出 margin（防爆上限）。 */
maxCompletionTokens) {
    const body = {
        model: ep.model,
        messages: contextWire !== undefined
            ? [...contextWire, { role: 'user', content: prompt }]
            : [{ role: 'user', content: prompt }],
        temperature: 0,
    };
    if (maxCompletionTokens !== undefined)
        body['max_completion_tokens'] = maxCompletionTokens;
    if (contextTools !== undefined)
        body['tools'] = contextTools;
    if (useJsonSchema) {
        // JSON Schema 强制输出：支持结构化解码的端点上消灭自由生成失控（plan 已知债务 7 的
        // "服务端 schema 约束"路径）；strict=true 要求全部字段受 schema 约束。
        body['response_format'] = {
            type: 'json_schema',
            json_schema: { name: 'argp_peratom_turn', strict: true, schema: OUTPUT_SCHEMA },
        };
    }
    // ctk 由调用方解析（resolveEffectiveCtk：继承主链 requestHeader ctk + enable_thinking:false
    // 覆盖）。此处不再强制 preserve_thinking——2026-09-19 定案：A 形态末尾 user 指令把
    // last_query_index 推到末尾，pt:true 反而把 P_last 剥掉的跨轮 reasoning 渲染回来
    // （LCP 12.7% < pt:false 30.3%）；继承主链 ctk 才是同态渲染的正确姿势。
    if (chatTemplateKwargs !== undefined && Object.keys(chatTemplateKwargs).length > 0) {
        body['chat_template_kwargs'] = chatTemplateKwargs;
    }
    const res = await fetchImpl(ep.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ep.apiKey}` },
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify(body),
    });
    if (!res.ok)
        throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = await res.json();
    return json.choices?.[0]?.message?.content ?? '';
}
/** 日志尾部的 open turn（flush 时刻 compaction 括号的 owner；null=standalone）。 */
function detectOpenTurn(session) {
    const events = sessionEvents(session);
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event === undefined)
            continue;
        if (event.type === 'turn/start')
            return event.data.turn;
        if (event.type === 'turn/end')
            return null;
    }
    return null;
}
export class PeratomCompressor {
    static inject = [];
    splitThresholdChars;
    smallResultChars;
    timeoutMs;
    /** HLS 修复档（v1.2.0 组件 B；生产缺省 'trailer'，'off' = v1.1 硬拒行为）。 */
    hlsMode;
    /** HLS 经济学门槛 θ（v1.2.0 门控修正；缺省 1）。 */
    hlsRoiThreshold;
    /** 压缩调用输出 cap（默认 4096；JSON plan 输出通常几百 token，小 cap 给 prompt 让出 margin）。 */
    maxCompletionTokens;
    /** A 形态前缀预算（默认 132000 ≈ 0.76×174080；前缀超预算 ⇒ 该次降级 C 形态）。 */
    prefixBudgetTokens;
    /** 轮末 pass 落地等待上界（ms，默认 180_000；0 = 不等，退回"绝不 await 网络"）。 */
    flushWaitMs;
    /**
     * 在飞的轮末 pass（仅 idle 路径登记）：pre-step 据此决定是否等待其落地。
     * 值 = "该 session 的全部在飞 pass 都已 settle" 的**屏障** promise——新 pass 到来时
     * 串联在旧屏障之后（`prior.then(() => pass)`；pass 本身已在跑，不因此串行化）。
     */
    inFlightPass = new WeakMap();
    chatTemplateKwargs;
    endpoint;
    dshLlm;
    /**
     * 自动兜底候选（§11.13.1）：显式 `config.llm` 与 fetch（endpoint/apiKey/env）两路
     * 都缺省时置 true，后端改为在真会话里延迟解析（agent 路由 + 宿主 ctx.llm）。
     */
    llmAutoEligible;
    /** 延迟解析出的后端（来自 agent 路由；构造期拿不到路由，故后置填充）。 */
    autoLlm = null;
    fetchImpl;
    ctx;
    /** LLM 压缩调用计数器（纯 dialog 轮零调用的断言读这里）。 */
    _calls = 0;
    get calls() { return this._calls; }
    /** 全部压缩尝试记录（时间序）。 */
    records = [];
    /** 当前暂存待发射的事务数（测试/P4 判断 stash 是否就绪）。 */
    get pendingCount() { return this.pending.length; }
    /**
     * 每轮压缩**水位**：(session, turn) → 已被规划过的最大 seq（-1 = 未压过）。
     *
     * 语义（2026-09-21 修订，替代原 `doneTurns` 的"轮级一次性"）：
     *  - **成功的 pass** 把该轮水位推进到本次窗口的 `endSeq`（= 规划器已考虑过的边界）；
     *  - 后续 pass（轮末 idle 或再次压力）**只收 `seq > 水位` 的原子** ⇒ 轮内压力 pass
     *    不再吃掉轮末 idle pass，同一轮可增量再压。真环境 2026-09-21 实证：turn 6 的
     *    轮内 pass（step 85）用掉唯一配额后，step 85-92 的新增内容永不入压。
     *  - 门控短路（`no-candidate`）/ 中断轮**不推进水位** ⇒ 该轮仍可被后续 pass 处理
     *    （原实现把 `done.add` 放在门控**之前**，一次 no-candidate 即永久作废该轮）。
     *  - 天然幂等：同一轮无新增原子时窗口为空 ⇒ collect 返回 null ⇒ 零 LLM 调用。
     *  - 未推进水位的重复调用只做一次日志扫描（无网络、无事务），代价可忽略。
     */
    passWatermark = new WeakMap();
    /** idle 阶段产出、等待下一次 open-turn 窗口发射的事务。 */
    pending = [];
    /**
     * tool 对照表 / 作者声明（设计 §6-2）：工具种类名 → 压缩档位。
     * 未声明的工具缺席默认（走大小启发式）；声明只放宽/收紧启发式，不可越过版本链硬排除。
     */
    toolPolicies = new Map();
    /** tool 对照表查询（测试 / P4 接线断言用）。 */
    getToolPolicy(toolName) { return this.toolPolicies.get(toolName); }
    /**
     * 声明某工具种类的压缩档位（设计 §6-2 `setToolPolicy(toolName, policy)`）。
     * `false`=永不压缩（保原文）；'summary'=一句话概括；'extract'=关键内容摘录。
     * 传 `undefined` 撤销声明（回启发式默认）。声明是"提示非命令"：
     * 版本链硬排除（决策序第 1 层）与保真守卫仍先行，错误方向只往"少压"错。
     */
    setToolPolicy(toolName, policy) {
        if (policy === undefined)
            this.toolPolicies.delete(toolName);
        else
            this.toolPolicies.set(toolName, policy);
    }
    /** 门控选项快照：大小阈值 + tool 对照表（prepare / compressCurrentTurn 两处同口径）。 */
    gateOptions() {
        return { smallResultChars: this.smallResultChars, toolPolicies: this.toolPolicies };
    }
    /** 某轮已规划过的最大 seq（-1 = 未压过）。 */
    waterMarkOf(session, turn) {
        return this.passWatermark.get(session)?.get(turn) ?? -1;
    }
    /** 成功落地后推进水位（单调不回退）。 */
    advanceWaterMark(session, turn, endSeq) {
        let marks = this.passWatermark.get(session);
        if (marks === undefined) {
            marks = new Map();
            this.passWatermark.set(session, marks);
        }
        if (endSeq > (marks.get(turn) ?? -1))
            marks.set(turn, endSeq);
    }
    /** 测试 / 诊断入口：读某轮的压缩水位。 */
    turnWaterMark(session, turn) {
        return this.waterMarkOf(session, turn);
    }
    /**
     * 该事件是否为**可压缩的原始材料**（唯一判据，三处共用）。
     *
     * 两类事件不是材料，必须同时从「候选」与「窗口边界（startSeq/endSeq）」里排除：
     *  - **压缩产物**：`surfaceOp` 存在且非 `'append'`（本压缩器 / 图剪写回的替换副本）。
     *    它是上一次 pass 的结果；水位语义下同一轮会被多次 collect，放进去会让
     *    窗口恒非空（每次 pass 都以 no-candidate 重复记账），且副本的
     *    `message.source.kind` 仍是 `'tool'`，plugin-source 判据拦不住 ⇒ 有二次摘要风险。
     *  - **插件注入**：`user/message` 且 `source.kind === 'plugin'`（A 形态前缀指令、
     *    U-info 聚合副本、checkpoint）。这类事件由引擎/本压缩器自己写入，不是会话材料；
     *    边界若把它们算进去，纯注入窗口会返回"空候选的非 null 收集"（同上噪声问题）。
     *
     * 判据口径与 `argp-t1-engine.shadowedSeqs` 的 replace 判定一致。
     */
    isMaterial(event) {
        // 只有对话载体（U/A/R）才构成压缩窗口；turn/start·end、compaction/*、
        // request/header 等旁路事件既不是候选、也不该把窗口撑成"非空"。
        if (event.type !== 'user/message' && event.type !== 'assistant/message' && event.type !== 'tool/result')
            return false;
        const surfaceOp = event.surfaceOp;
        if (surfaceOp !== undefined && surfaceOp !== 'append')
            return false;
        if (event.type !== 'user/message')
            return true;
        const kind = event.data?.source?.kind;
        return kind !== 'plugin';
    }
    constructor(ctx, config = {}) {
        this.ctx = ctx;
        this.dshLlm = config.llm ?? null;
        this.endpoint = config.endpoint !== undefined
            ? {
                endpoint: config.endpoint,
                model: config.model ?? 'deepseek-v4-flash',
                apiKey: config.apiKey ?? '',
            }
            : (config.apiKey !== undefined ? { endpoint: config.endpoint ?? 'https://api.deepseek.com/chat/completions', model: config.model ?? 'deepseek-v4-flash', apiKey: config.apiKey } : defaultEndpoint());
        this.splitThresholdChars = config.splitThresholdChars ?? SPLIT_THRESHOLD_CHARS;
        this.smallResultChars = config.smallResultChars ?? DEFAULT_SMALL_RESULT_CHARS;
        this.timeoutMs = config.timeoutMs ?? 180_000;
        this.flushWaitMs = config.flushWaitMs ?? 180_000;
        this.hlsMode = config.hlsMode ?? 'trailer';
        this.hlsRoiThreshold = config.hlsRoiThreshold ?? DEFAULT_HLS_ROI_THRESHOLD;
        this.chatTemplateKwargs = config.chatTemplateKwargs;
        this.maxCompletionTokens = config.maxCompletionTokens ?? 16_384;
        this.prefixBudgetTokens = config.prefixBudgetTokens ?? 132_000;
        if (config.toolPolicies !== undefined) {
            for (const [name, policy] of config.toolPolicies)
                this.toolPolicies.set(name, policy);
        }
        this.fetchImpl = config.fetchImpl ?? ((...args) => fetch(...args));
        // 显式 llm 与 fetch 两路都缺省 ⇒ 进入自动兜底（真会话里解析 agent 路由）。
        this.llmAutoEligible = config.llm === undefined && this.endpoint === null;
        if (this.endpoint === null && this.dshLlm === null) {
            if (this.llmAutoEligible) {
                ctx.logger.info('peratom-compressor: no explicit LLM backend; auto mode — will follow the host dsh-llm + agent route once a real session provides one (disabled, zero network, until then)');
            }
            else {
                ctx.logger.warn('peratom-compressor: no LLM backend resolved (set DEEPSEEK_API_KEY, pass config.llm, or pass config); compressor disabled');
            }
        }
        // 触发钩子：轮末 idle（当轮必已闭）→ 收集 + LLM（异步，不阻塞状态切换）。
        // 同时把该 pass 登记为"在飞"（屏障），供 pre-step 决定是否等待（见 flushWaitMs）。
        ctx.on('agent/status', ({ agent, status }) => {
            this.rememberRoute(agent);
            if (status !== 'idle')
                return;
            const pass = this.prepareCurrentTurn(agent.session).catch(error => {
                this.ctx.logger.warn(`peratom-compressor prepare failed: ${error instanceof Error ? error.message : String(error)}`);
            });
            const prior = this.inFlightPass.get(agent.session);
            this.inFlightPass.set(agent.session, prior === undefined ? pass : prior.then(() => pass, () => pass));
        });
        // 发射窗口：下一次 agent/pre-step（open turn 已开、新 user/message 未落盘）。
        // 先**有界等待**在飞的轮末 pass（flushWaitMs，默认 180s），再同步追加已就绪条目
        // （flushStashed 本身仍是同步、不 await 网络）。等待保证"下一个 user message 的
        // 首个请求"带上本次压缩结果，而不是让替换副本落在新轮中途。超时不阻塞：告警后照旧
        // 放行，事务在后续窗口落地。
        ctx.on('agent/pre-step', async ({ agent }, next) => {
            this.rememberRoute(agent);
            await this.awaitInFlightPass(agent.session);
            this.flushStashed(agent.session);
            return next();
        });
    }
    /**
     * 有界等待在飞的轮末 pass（见 `PeratomCompressorConfig.flushWaitMs`）。
     * 取走屏障（同一批 pass 只在首个 pre-step 等一次）；超时/失败都不抛——宁可放行让
     * 事务顺延到后续窗口，也不把用户这一轮卡死。
     */
    awaitInFlightPass(session) {
        const pass = this.inFlightPass.get(session);
        if (pass === undefined || this.flushWaitMs <= 0)
            return Promise.resolve();
        this.inFlightPass.delete(session);
        this.ctx.logger.info(`peratom-compressor: turn-end pass in flight; holding this pre-step up to ${this.flushWaitMs}ms for it to land (avoids mid-turn surface replacement)`);
        return new Promise(resolve => {
            let settled = false;
            let timer;
            const finish = (timedOut) => {
                if (settled)
                    return;
                settled = true;
                if (timer !== undefined)
                    clearTimeout(timer);
                if (timedOut) {
                    this.ctx.logger.warn(`peratom-compressor: turn-end pass still in flight after ${this.flushWaitMs}ms; releasing this turn's first request without it (the transaction lands at a later pre-step window)`);
                }
                resolve();
            };
            timer = setTimeout(() => finish(true), this.flushWaitMs);
            void pass.then(() => finish(false), () => finish(false));
        });
    }
    // -- LLM 后端选择 -------------------------------------------------------
    /**
     * 记住 agent 路由（§11.13.1 自动兜底）。构造期拿不到路由，只能在真会话的
     * `agent/status` / `agent/pre-step` 钩子里现取。非自动模式直接短路。
     */
    rememberRoute(agent) {
        if (!this.llmAutoEligible)
            return;
        try {
            const spec = autoDshLlmSpec(this.ctx, agent?.options ?? null);
            if (spec !== null)
                this.autoLlm = spec;
        }
        catch { /* 路由解析失败：保持原值，退化为 disabled（零网络） */ }
    }
    /**
     * 后端选路（§11.13.1）：显式 `config.llm` > fetch（endpoint/apiKey/env）> 自动兜底。
     * 三条都解不出返回 null —— 调用方按 disabled 记账（`no-endpoint`），不抛错、不阻断会话。
     */
    backend() {
        if (this.dshLlm !== null)
            return { kind: 'dsh-llm', spec: this.dshLlm };
        if (this.endpoint !== null)
            return { kind: 'fetch', endpoint: this.endpoint };
        if (this.autoLlm !== null)
            return { kind: 'dsh-llm', spec: this.autoLlm };
        return null;
    }
    // -- 收集 ---------------------------------------------------------------
    /**
     * 收集当前（最新闭合）轮的可压原子。内嵌三道确定性过滤：
     * ① 中断轮整轮排除（filterInterruptedAtoms，interrupted=true 时数组恒空）；
     * ② 版本链成员硬排除（决策④，need_compress=false）；③ 大小启发式门控。
     * 无再压缩路径：U-info 副本 / plugin checkpoint 一律跳过（决策⑦）。
     */
    collectCurrentTurn(session, afterSeq) {
        const events = sessionEvents(session);
        let closed = null;
        for (let i = events.length - 1; i >= 0; i -= 1) {
            const event = events[i];
            if (event?.type === 'turn/end') {
                closed = event.data.turn;
                break;
            }
        }
        if (closed === null)
            return null;
        // 水位（2026-09-21）：缺省取该轮「已规划边界」，只收其后新增事件 ⇒ 同轮可增量再压。
        const since = afterSeq ?? this.waterMarkOf(session, closed);
        // 归轮按位置：user/message 事件不携带 turn 字段（rc.2 类型），其归属 =
        // 当前开放的 turn（turn/start..end 之间的日志区间）。assistant/tool 事件自带
        // turn 字段做二次校验。替换副本（dialog/U-info/tool copy）落在本窗口内的，
        // 由 plugin-source 跳过 / 版本链同键硬排除兜住，不会被误当原始态原子。
        const turnEvents = [];
        let startSeq = Number.MAX_SAFE_INTEGER;
        let endSeq = -1;
        let open = null;
        for (const event of events) {
            if (event.type === 'turn/start') {
                open = event.data.turn;
                continue;
            }
            if (event.type === 'turn/end') {
                open = null;
                continue;
            }
            if (open !== closed)
                continue;
            if (event.seq <= since)
                continue; // 水位过滤：只收上次规划边界之后的新增事件
            if (!this.isMaterial(event))
                continue; // 压缩产物 / 插件注入不算窗口（见 isMaterial）
            if (event.type !== 'user/message') {
                const turn = event.data?.turn;
                if (typeof turn === 'number' && turn !== closed)
                    continue;
            }
            turnEvents.push(event);
            if (event.seq < startSeq)
                startSeq = event.seq;
            if (event.seq > endSeq)
                endSeq = event.seq;
        }
        return this.collectFromWindow(session, closed, turnEvents, startSeq, endSeq);
    }
    /**
     * 收集当前开放轮（最后一条 turn/start 之后、尚无 turn/end）的可压原子。
     * P4 溢出三步路径②专用：溢出发生在 open turn 的请求上，第②步要降熵的正是
     * 这个 open turn——closed-turn 口径会错压上一闭合轮（2026-08-29 review 中项，
     * 与 per-atom 设计 §8「对当前轮大原子降熵」的意图不符）。过滤与闭合轮完全
     * 同款（中断/版本链/大小门控；U-info/checkpoint 跳过）；open turn 无 turn/end，
     * 不会出现在中断集里。无 turn/start（会话头）返回 null。
     */
    collectOpenTurn(session, afterSeq) {
        const events = sessionEvents(session);
        let openSeq = -1;
        let openTurn = null;
        for (let i = events.length - 1; i >= 0; i -= 1) {
            const event = events[i];
            if (event?.type === 'turn/start') {
                openSeq = event.seq;
                openTurn = event.data.turn;
                break;
            }
        }
        if (openTurn === null || openSeq < 0)
            return null;
        // 水位（2026-09-21）：缺省取该 open 轮「已规划边界」，只收其后新增事件 ⇒ 轮内
        // 压力 pass 之后，轮末 idle pass 仍能压新增原子（不再被一次性配额吃掉）。
        const since = afterSeq ?? this.waterMarkOf(session, openTurn);
        // open 窗口 = 最后一条 turn/start 之后的全部事件。user/message 按位置归属；
        // assistant/tool 事件自带 turn 字段做二次校验（应恒等于 openTurn）。
        const turnEvents = [];
        let startSeq = Number.MAX_SAFE_INTEGER;
        let endSeq = -1;
        for (const event of events) {
            if (event.seq <= openSeq)
                continue;
            if (event.seq <= since)
                continue; // 水位过滤：只收上次规划边界之后的新增事件
            if (!this.isMaterial(event))
                continue; // 压缩产物 / 插件注入不算窗口（见 isMaterial）
            if (event.type !== 'user/message' && event.type !== 'turn/end') {
                const turn = event.data?.turn;
                if (typeof turn === 'number' && turn !== openTurn)
                    continue;
            }
            turnEvents.push(event);
            if (event.seq < startSeq)
                startSeq = event.seq;
            if (event.seq > endSeq)
                endSeq = event.seq;
        }
        return this.collectFromWindow(session, openTurn, turnEvents, startSeq, endSeq);
    }
    /** 窗口→候选的共享尾部（中断/版本链/大小门控 + 原子化）。closed/open 两口径共用。 */
    collectFromWindow(session, turn, turnEvents, startSeq, endSeq) {
        const events = sessionEvents(session);
        if (endSeq < 0)
            return null;
        const interrupted = collectInterruptedTurns(events).has(turn);
        const collect = {
            turn,
            startSeq,
            endSeq,
            interrupted,
            userLong: [],
            toolResults: [],
        };
        if (interrupted)
            return collect;
        // 中断过滤作用于投影前的原始事件流：被标记轮次的残留原子不进候选。
        const chain = buildVersionChainIndex(events);
        const nameByCall = buildToolNameIndex(events);
        const rawAtoms = [];
        for (const event of turnEvents) {
            if (!this.isMaterial(event))
                continue; // 安全网：非材料（压缩产物 / 插件注入）永不入候选
            const data = event.data;
            if (event.type === 'user/message') {
                // U-info 聚合副本 / checkpoint / A 形态指令均为 plugin-source —— 已由 isMaterial 排除。
                const text = projectSurfaceText(event);
                if (userIsLong(text, this.splitThresholdChars)) {
                    rawAtoms.push({ kind: 'user-long', seq: event.seq, turn, text });
                }
                continue;
            }
            if (event.type === 'tool/result') {
                const callId = data?.message?.source?.callId;
                const text = projectSurfaceText(event);
                // 工具种类名（callId→name 反查）：tool 对照表 / 作者声明的查找键（设计 §6-2）。
                const toolName = callId !== undefined ? nameByCall.get(callId) : undefined;
                rawAtoms.push({ kind: 'tool-result', seq: event.seq, turn, text, callId, toolName });
            }
            // assistant/message 不压缩（设计 §1）。
        }
        const survivors = filterInterruptedAtoms(rawAtoms, events);
        for (const atom of survivors) {
            if (atom.kind === 'user-long') {
                collect.userLong.push(atom);
            }
            else if (rNeedCompress(atom, chain, this.gateOptions()) !== false) {
                collect.toolResults.push(atom);
            }
        }
        return collect;
    }
    // -- 两段式：idle 准备 → pre-step 发射 ----------------------------------
    /** idle 触发段：记账防重 → 收集 → 门控 → LLM → 暂存待发射。返回观测记录。 */
    async prepareCurrentTurn(session) {
        // 水位过滤内建（collect 缺省取该轮已规划边界）：已压过的原子不再入候选 ⇒ 幂等；
        // 窗口为空（无新增原子）时 collect 返回 null ⇒ 零调用短路。
        const collect = this.collectCurrentTurn(session);
        if (collect === null)
            return null;
        const chain = buildVersionChainIndex(sessionEvents(session));
        if (collect.interrupted) {
            const record = { at: new Date().toISOString(), turn: collect.turn, called: false, skipReason: 'interrupted' };
            this.records.push(record);
            return record; // 中断轮：error/aborted 收尾，半成品不进候选（宁全勿漏）；不推进水位
        }
        if (!turnCompressible([...collect.userLong, ...collect.toolResults], chain, this.gateOptions())) {
            const record = { at: new Date().toISOString(), turn: collect.turn, called: false, skipReason: 'no-candidate' };
            this.records.push(record);
            return record; // 纯 dialog / 版本链成员 / 全小结果：零调用短路；不推进水位
        }
        const entry = await this.callAndStash(session, collect);
        if (entry.error === undefined && !entry.parseFailed)
            this.advanceWaterMark(session, collect.turn, collect.endSeq); // 成功规划才推进水位
        return entry;
    }
    /** 发射段：把该 session 的全部就绪事务落入下一次 open-turn 窗口（同步追加，吞错记账）。 */
    flushStashed(session) {
        while (true) {
            const idx = this.pending.findIndex(e => e.session === session);
            if (idx < 0)
                return;
            const [entry] = this.pending.splice(idx, 1);
            try {
                this.flushEntry(entry.session, entry.collect, entry.decision, entry.record);
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                this.ctx.logger.warn(`peratom-compressor flush failed: ${message}`);
                this.records.push({ at: new Date().toISOString(), turn: entry.collect.turn, called: true, error: message });
            }
        }
    }
    /** 公开入口（P4 溢出三步路径② / 单测）：立即收集+调用+发射，绕过两段式延迟。 */
    async compressCurrentTurn(session) {
        const collect = this.collectCurrentTurn(session);
        return this.compressCollect(session, collect);
    }
    /**
     * 公开入口（P4 溢出三步路径② 生产接线）：对当前 open turn 立即收集+调用+发射。
     * 溢出发生在 open turn 的请求上，第②步必须压它而不是最新闭合轮（设计 §8
     * 「对当前轮大原子降熵」；closed 口径会错压上一轮，2026-08-29 review 中项）。
     * 水位语义（2026-09-21 修订）：open turn 压缩后**只推进该轮水位**（= 本次窗口 endSeq），
     * 该轮闭合时 idle prepare 仍会跑，但只收水位之后的新增原子（原先的"轮级一次性"
     * 记账会让轮内 pass 吃掉轮末 pass，使该轮尾部永不入压）。
     */
    async compressOpenTurn(session) {
        const collect = this.collectOpenTurn(session);
        return this.compressCollect(session, collect);
    }
    /** 共享压缩尾部：中断/无候选短路（不推进水位）+ callAndStash + 立即 flush（成功才推进水位）。 */
    async compressCollect(session, collect) {
        if (collect === null)
            return null;
        const chain = buildVersionChainIndex(sessionEvents(session));
        if (collect.interrupted) {
            const record = { at: new Date().toISOString(), turn: collect.turn, called: false, skipReason: 'interrupted' };
            this.records.push(record);
            return record; // 不推进水位：该轮仍可被后续 pass 处理
        }
        if (!turnCompressible([...collect.userLong, ...collect.toolResults], chain, this.gateOptions())) {
            const record = { at: new Date().toISOString(), turn: collect.turn, called: false, skipReason: 'no-candidate' };
            this.records.push(record);
            return record; // 不推进水位（原实现在此之前 done.add ⇒ 一次 no-candidate 永久作废该轮）
        }
        const entry = await this.callAndStash(session, collect);
        if (entry.error === undefined && !entry.parseFailed)
            this.advanceWaterMark(session, collect.turn, collect.endSeq); // 成功规划才推进水位
        this.flushStashed(session);
        return entry;
    }
    // -- LLM 调用与暂存 ------------------------------------------------------
    /**
     * A 形态前缀快照（设计文档 §4 tail-only 语义的落地）：agent 当前
     * `deriveMessages()` + `requestHeader().tools` + 主链 ctk。
     *
     * 时序依据（2026-09-18/19 record 实测）：
     * - 轮边界触发（idle）：derive = 刚结束轮的全量，复用对象 = P_last / 下一轮第一发；
     * - 轮内触发（pre-step，P6）：derive = 进行到一半的 turn N，复用对象 = 紧随其后的
     *   step k+1 请求。两条路径共用本快照函数，前缀 = 触发时刻的 deriveMessages()。
     * 无 header 事件（会话首请求前）时 tools 缺省，消息前缀仍可用。
     */
    buildContextPrefix(session) {
        const messages = session.deriveMessages();
        const header = session.requestHeader();
        return { messages, ...(header?.tools !== undefined ? { tools: header.tools } : {}) };
    }
    /**
     * 方案 B ctk（2026-09-19 定案，替代旧的"强制 pt:true"）：
     *   { enable_thinking:false, preserve_thinking:false, reasoning_effort:<主链同值?>, ...config 基础层 }
     * 三字段各自的理由：
     *  - `preserve_thinking:false`（方案 B 核心）：压缩请求末尾必是 user 指令 ⇒ 模板把
     *    last_query_index 推到末尾 ⇒ 历史轮内 reasoning 被剥 = **剥离态**。这恰好与
     *    "下一轮第一发 agent 请求"（末尾也是 user，同为剥离态）**同态** ⇒ 前缀逐 token
     *    一致（plan B 实测 LCP 99.4%）。强制 pt:true 反而把跨轮 reasoning 渲染回来，
     *    与参照不同态（LCP 12.7% < pt:false 30.3%）。
     *  - `enable_thinking:false`：压缩响应是 JSON plan，不烧 thinking（spike 33）。
     *  - `reasoning_effort`：与主链对齐（若声明了）——匹配主链的渲染 token 序列，
     *    跨模型可移植（不依赖 Qwen3 专属 pt 语义）。
     * 主链 reasoningEffort 取自最近 `request/header` 事件的 config（LlmCallConfig 无
     * chat_template_kwargs 字段，只有 reasoningEffort——故从它重建，非读现成 ctk）。
     */
    resolveEffectiveCtk(session) {
        const events = sessionEvents(session);
        let mainChainEffort;
        for (let i = events.length - 1; i >= 0; i -= 1) {
            const event = events[i];
            if (event?.type !== 'request/header')
                continue;
            const cfg = event.data?.header?.config;
            if (cfg?.reasoningEffort !== undefined) {
                mainChainEffort = cfg.reasoningEffort;
                break;
            }
        }
        const ctk = { ...(this.chatTemplateKwargs ?? {}) };
        ctk['enable_thinking'] = false;
        ctk['preserve_thinking'] = false;
        if (mainChainEffort !== undefined)
            ctk['reasoning_effort'] = mainChainEffort;
        return ctk;
    }
    /**
     * 前缀预算门控（防爆上限核心防线）：估算 A 形态请求的 prompt_tokens
     * = 最近一次真实 agent 请求的 billed input + 指令字符估算（/4，chars/4 对
     * 指令这种短文本偏安全）。usage 挂 assistant/message 事件的 data **顶层**
     * （agent-loop 落账实证 `{turn, step, message, usage, stream}`，读
     * `data.message.usage` 恒 undefined ⇒ A 形态会被静默全量降级 C）；billed
     * 口径 = inputTokens（未命中）+ cacheReadTokens + cacheWriteTokens，与引擎
     * 真实锚点同式——只算未命中会在高缓存命中率时大幅低估、漏放行超预算请求。
     * 超预算 ⇒ 返回 false，调用方**该次降级 C 形态**（丢前缀只发指令）——
     * "全前缀或无前缀"二元门控：截断前缀要么砍最近历史（质量最伤）要么 0 命中
     * 还比 C 贵（被支配）。无 usage 可参照（会话头）⇒ 保守返回 false（降级 C）。
     */
    prefixWithinBudget(session, promptChars) {
        const events = sessionEvents(session);
        for (let i = events.length - 1; i >= 0; i -= 1) {
            const event = events[i];
            if (event?.type !== 'assistant/message')
                continue;
            const usage = event.data?.usage;
            if (usage === undefined || typeof usage.inputTokens !== 'number')
                continue;
            const billedInput = usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
            const estimate = billedInput + Math.ceil(promptChars / 4);
            if (estimate > this.prefixBudgetTokens)
                return false;
            return true;
        }
        return false;
    }
    async callAndStash(session, collect) {
        const record = { at: new Date().toISOString(), turn: collect.turn, called: true };
        this.records.push(record);
        const backend = this.backend();
        if (backend === null) {
            record.error = 'no-endpoint';
            return record;
        }
        this._calls += 1;
        const started = Date.now();
        try {
            const prompt = buildPrompt(collect);
            record.atomSeqs = {
                userLong: collect.userLong.map(u => u.seq),
                toolResults: collect.toolResults.map(t => t.seq),
            };
            // A 形态前缀 + 预算门控：超预算该次降级 C（丢前缀只发指令），防爆上限。
            const context = this.buildContextPrefix(session);
            const effectiveCtk = this.resolveEffectiveCtk(session);
            const usePrefix = this.prefixWithinBudget(session, prompt.length);
            if (!usePrefix)
                record.degradedToC = 'prefix-budget';
            this.ctx.logger.info(`[argp-peratom] compressor: turn ${collect.turn} candidates=${collect.userLong.length}u+${collect.toolResults.length}r (dsh-llm=${backend.kind === 'dsh-llm'}, prefix=${usePrefix ? context.messages.length + ' msgs' : 'OFF (degraded C)'}, ctk=${JSON.stringify(effectiveCtk)})`);
            let raw;
            let ms = Date.now() - started;
            if (backend.kind === 'dsh-llm') {
                // dsh-llm 生产后端：GenerateOptions 无 response_format——schema 约束仅在 fetch
                // 后端可用，此路径一次到位，依赖 extractJson 兜底解析（无 schema 重试舞蹈）。
                // A 形态：deriveMessages() 前缀 + 指令尾部 user；ctk 由宿主 compat 决定
                //（本机 qwen-chat-template 硬编码 preserve_thinking:true，见 llm-adapter 头注——
                // 该路径的同态对齐依赖宿主，fetch 路径才是 ctk 继承的完全控制面）。
                const res = await completeViaDshLlm(this.ctx, backend.spec, prompt, this.timeoutMs, usePrefix ? context.messages : undefined, usePrefix ? context.tools : undefined);
                raw = res.text;
                if (res.usage !== undefined)
                    record.usage = res.usage;
                ms = Date.now() - started;
            }
            else {
                const contextWire = usePrefix ? serializeWireMessages(context.messages) : undefined;
                const contextTools = usePrefix ? serializeWireTools(context.tools) : undefined;
                try {
                    raw = await postChat(this.fetchImpl, backend.endpoint, prompt, this.timeoutMs, true, effectiveCtk, contextWire, contextTools, this.maxCompletionTokens);
                    ms = Date.now() - started;
                }
                catch (schemaError) {
                    // response_format 被端点拒绝/网络抖动：spike 30/32 兼容模式重试一次（裸 prompt）。
                    raw = await postChat(this.fetchImpl, backend.endpoint, prompt, this.timeoutMs, false, effectiveCtk, contextWire, contextTools, this.maxCompletionTokens);
                    ms = Date.now() - started;
                    record.anomalies = (record.anomalies ?? 0) + 1;
                    void schemaError;
                }
            }
            record.ms = ms;
            record.rawResponse = raw;
            const decision = normalizeDecision(extractJson(raw));
            if (decision === null) {
                record.parseFailed = true;
                return record; // 解析失败静默跳过：本轮保原文（安全方向），绝不阻断会话
            }
            record.decision = decision;
            this.pending.push({ session, collect, decision, record });
            const extract = decision.tools.filter(t => t.level === 'extract').length;
            const summary = decision.tools.filter(t => t.level === 'summary').length;
            const falseActions = decision.tools.filter(t => t.level === 'false').length;
            this.ctx.logger.info(`[argp-peratom] compressor: turn ${collect.turn} decision splits=${decision.splits.length} extract=${extract} summary=${summary} false=${falseActions} ms=${record.ms ?? '?'}`);
        }
        catch (error) {
            record.error = error instanceof Error ? error.message : String(error);
            this.ctx.logger.warn(`[argp-peratom] compressor: turn ${collect.turn} LLM call failed: ${record.error}`);
        }
        return record;
    }
    // -- 事务括号发射（仿 t1：start..end，双事件/多事件发射，断言内联）-------
    flushEntry(session, collect, decision, record) {
        const plan = planReplacements(collect, decision, sessionEvents(session), { hlsMode: this.hlsMode, hlsRoiThreshold: this.hlsRoiThreshold });
        if (plan.steps.length === 0) {
            // 全部动作被拒（保真守卫/回退）或零动作：不开空事务，但统计直接落账到本次记录。
            record.skippedFallbackDialog = plan.skippedFallbackDialog;
            record.skippedFidelity = plan.skippedFidelity;
            record.skippedFalse = plan.skippedFalse;
            record.skippedNoopGain = plan.skippedNoopGain;
            if (plan.summaryDropped.length > 0)
                record.summaryDropped = plan.summaryDropped;
            if (plan.hlsRepairs > 0)
                record.hlsRepairs = plan.hlsRepairs;
            if (plan.restoredByGuard.length > 0)
                record.restoredByGuard = plan.restoredByGuard;
            if (plan.hlsRoiSkipped > 0)
                record.hlsRoiSkipped = plan.hlsRoiSkipped;
            record.fidelityMissing = plan.fidelityMissing;
            record.anomalies = (record.anomalies ?? 0) + plan.anomalies;
            return;
        }
        const openTurn = detectOpenTurn(session);
        const compactionId = CompactionId('argp-peratom-' + randomUUID());
        const lifecycle = { compactionId, turn: openTurn };
        const genBefore = session.surface.replaceGeneration;
        session.append('compaction/start', lifecycle);
        try {
            let replaceCount = 0;
            // dsh 0.1.5 起 `Session.append` 的 opts 是条件元组（`assistant/message` 禁带
            // sourceEventSeqs、其余 surface 事件允许），而 `step.type` 是
            // 'user/message' | 'tool/result' 的联合 → TS 无法为联合选定单一重载。
            // 该联合本身已保证两者都允许 sourceEventSeqs，故仅在类型层收窄掉泛型分派；
            // 运行时仍走 `Session.append` 同一条校验路径（品牌校验、surface 计划、provenance）。
            const appendSurface = session.append.bind(session);
            for (const step of plan.steps) {
                // UI checkpoint 关联（2026-08-28）：user/message 替换副本的 source 换为
                // compact checkpoint（与图剪墓碑同款）——宿主 CompactionNodeView 据此把事务
                // 渲染为"上下文已压缩"节点。tool/result 替换受宿主硬约束"只许改 content"，
                // 不能换 source，故仅 user/message 步骤携带。
                if (step.type === 'user/message') {
                    step.data = { ...step.data, source: compactCheckpointSource(compactionId) };
                }
                // 断言 1：sourceEventSeqs ⊆ 当轮区间（越界即 bug，plan P1 硬性要求）。
                for (const seq of step.sourceEventSeqs) {
                    if (seq < collect.startSeq || seq > collect.endSeq) {
                        throw new Error(`sourceEventSeq ${seq} outside current turn range [${collect.startSeq}, ${collect.endSeq}] (turn ${collect.turn})`);
                    }
                }
                if (step.kind === 'replace') {
                    const g0 = session.surface.replaceGeneration;
                    appendSurface(step.type, step.data, {
                        surfaceOp: { op: 'replace', startSeq: asSeq(step.at), endSeq: asSeq(step.at) },
                        sourceEventSeqs: asSeqs(step.sourceEventSeqs),
                    });
                    const g1 = session.surface.replaceGeneration;
                    // 断言 2：每次 replace 必须推进 replaceGeneration（替换真实落地）。
                    if (g1 <= g0) {
                        throw new Error(`replaceGeneration did not advance after replacing seq ${step.at} (${g0} -> ${g1})`);
                    }
                    replaceCount += 1;
                }
                else {
                    appendSurface(step.type, step.data, {
                        surfaceOp: 'append',
                        sourceEventSeqs: asSeqs(step.sourceEventSeqs),
                    });
                }
            }
            // 人类可读压缩摘要（2026-08-28 UI 联调）：compaction/summary 是 off-surface 日志
            // 事件（模型不可见），WebUI 的 compaction 节点用它作为展示文本——不发则节点显示
            // "压缩摘要不可用"（宿主 CompactionNodeView 的 summary 缺省文案）。payload 按
            // 宿主 CompactionSummary 词典填诚实值；类型收窄走 as never（代码库既有惯例）。
            const extractCount = decision.tools.filter(t => t.level === 'extract').length;
            const summaryCount = decision.tools.filter(t => t.level === 'summary').length;
            const falseCount = decision.tools.filter(t => t.level === 'false').length;
            const shadowedChars = [...collect.userLong, ...collect.toolResults]
                .reduce((sum, atom) => sum + atom.text.length, 0);
            // 后端标签反映**实际选路**（§11.13.1）：显式/自动 dsh-llm 报宿主路由，
            // fetch 报端点 URL，三者皆无报 disabled。审计脚本按此判"Stage-1 是否真的跑过"。
            const summaryBackend = this.backend();
            session.append('compaction/summary', {
                ...lifecycle,
                summary: [{
                        type: 'text',
                        text: `ARGP 逐原子压缩（turn ${collect.turn}）：${decision.splits.length} 拆分 / ${extractCount} 提取 / ${summaryCount} 摘要 / ${falseCount} 保原文；原文保留在 append-only 日志，recall_detail(seq) 可取回`,
                    }],
                shadowedRange: { start: collect.startSeq, end: collect.endSeq },
                shadowedSeqs: plan.steps.flatMap(step => step.sourceEventSeqs),
                shadowedTokenCount: Math.ceil(shadowedChars / 3.5),
                provider: summaryBackend?.kind === 'dsh-llm' ? summaryBackend.spec.provider : 'fetch',
                // ⚠️ fetch 分支要取 `endpoint.endpoint`（URL 字符串）：`endpoint` 本身是
                // ResolvedEndpoint 对象 {endpoint, model, apiKey}，`String(对象)` 序列化成
                // "[object Object]"（2026-09-18 ab4 跑批实测审计字段坏掉）——既丢 URL，也丢模型名，
                // 审计脚本无法判断 Stage-1 实际跑在哪个模型上。现在 model 段同时带模型名与端点 URL。
                model: summaryBackend === null
                    ? 'disabled'
                    : (summaryBackend.kind === 'dsh-llm'
                        ? summaryBackend.spec.model
                        : `${summaryBackend.endpoint.model} @ ${summaryBackend.endpoint.endpoint}`),
            });
            session.append('compaction/end', lifecycle);
            // 断言 2b：整事务代数增量 === replace 步数（append 步不推进代数）。
            const delta = session.surface.replaceGeneration - genBefore;
            if (delta !== replaceCount) {
                throw new Error(`replaceGeneration delta ${delta} != planned replaces ${replaceCount}`);
            }
            // 统计在事务成功落地后记账（失败路径由 flushStashed 的 error 记录承载）。
            record.appliedReplaces = replaceCount;
            record.skippedFallbackDialog = plan.skippedFallbackDialog;
            record.skippedFidelity = plan.skippedFidelity;
            record.skippedFalse = plan.skippedFalse;
            record.skippedNoopGain = plan.skippedNoopGain;
            if (plan.summaryDropped.length > 0)
                record.summaryDropped = plan.summaryDropped;
            if (plan.hlsRepairs > 0)
                record.hlsRepairs = plan.hlsRepairs;
            if (plan.restoredByGuard.length > 0)
                record.restoredByGuard = plan.restoredByGuard;
            if (plan.hlsRoiSkipped > 0)
                record.hlsRoiSkipped = plan.hlsRoiSkipped;
            record.fidelityMissing = plan.fidelityMissing;
            record.anomalies = (record.anomalies ?? 0) + plan.anomalies;
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            try {
                session.append('compaction/end', { ...lifecycle, error: message });
            }
            catch {
                // 关闭失败保留未配对 start，可被 inspectCompactionEntryState 检出（t1 同纪律）
            }
            throw error;
        }
    }
}
export default PeratomCompressor;
