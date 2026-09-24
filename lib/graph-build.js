import { sessionEvents, eventText } from './log-access.js';
import { matchCitesTail, parseCitesBlock } from './cites-strip.js';
import { deriveInferredEdges } from './token-ontology.js';
import { ARG_NS, isArgpUserInfo, isOwnSourceKind } from './peratom/types.js';
/**
 * A8（问题 10 修订）：ask 检测中英双语纯函数。
 * 英文：'?' / ask / what；中文：？/ 吗 / 呢 / 什么 / 怎么 / 如何 / 能否 / 能不能。
 * /帮我/ 由子串收窄为句首（^请|^帮我|^能不能|^能否），避免 "顺便帮我带个话" 之类
 * 非问句/非请求主语误命中；疑问词 什么/怎么/如何 仍保留子串（问句核心成分，方向保守=少剪）。
 * 导出供测试直接锁定收窄行为。
 */
export function looksAskText(text) {
    const t = text.trim();
    return t.endsWith('?') || /\bask\b/i.test(t) || /\bwhat\b/i.test(t)
        || t.endsWith('？') || /吗[？?。]?$/.test(t) || /呢[？?。]?$/.test(t)
        || /什么|怎么|如何|能否|能不能/.test(t)
        || /^(请|帮我|能不能|能否)/.test(t);
}
/**
 * user/message 原子分类（P0 分类陷阱防线，plan「分类陷阱」节）。
 *
 * 顺序不可交换：先识别 `data[argp].info === true`（U-info 聚合副本——由 peratom 管线
 * 插件 append，但必须按 U 待遇参与剪枝候选），再落「非 `user` 源 → X」（注入/checkpoint）
 * 判定。若先判非-user-source，U-info 会被分类成 X 而**全局不可剪**，
 * P4 的候选放行将永远失效。
 *
 * 判据**版本无关**：真实用户消息恒带 `source.kind === 'user'`（宿主 createUserMessage
 * 约定）；注入（V3 `plugin` / V4 `argp` / `compact-checkpoint`）命中自有来源白名单 ⇒ X。
 * 其余非-user kind（dsh-agent merge 扩展）不是 X——由正交的性质轴（form）裁决。
 *
 * 此前该规则内联在四处（catalogText / recallQuery / atomize / rebuildLedgerFromLog），
 * 现统一收敛到本纯函数；导出供测试直接锁定顺序行为（A8 先例）。
 */
export function classifyUserMessage(data) {
    if (isArgpUserInfo(data))
        return 'U';
    return isOwnSourceKind(data?.source?.kind) ? 'X' : 'U';
}
/**
 * 提取 A 文本尾部的 cites JSON（支持裸 JSON 与 ```json 围栏）；返回剥离后正文与引用列表。
 * V6 分级契约：条目可为字符串（视为 supporting）或 {t, l} 对象（l ∈ c|s|x）。
 * 形状不合法（如混入数字/对象缺 t）→ parseFailed 保守保护。
 */
export function extractCites(text) {
    const matched = matchCitesTail(text);
    const attempted = text.includes('"cites"');
    if (matched === null) {
        return { body: text, cites: [], attempted, parseFailed: attempted };
    }
    const cites = parseCitesBlock(matched.raw);
    if (cites === null) {
        return { body: text, cites: [], attempted: true, parseFailed: true }; // JSON 合法但形状不对 → 解析失败，保守保护
    }
    return { body: text.slice(0, text.length - matched.span).trimEnd(), cites, attempted: true, parseFailed: false };
}
/** n-gram 倒排索引的 n（A5；原 class 字段 `ngramN`，常量提升为模块级）。 */
const NGRAM_N = 3;
/**
 * 原子化（§4.1）：只投影 surface 节点；U/X/R/A 四类（tool/call 不进 surface，无 T 类）。cites 统计在 A 原子处累计。
 *
 * switch 认四类 surface 事件：`user/message` / `assistant/message` / `tool/result` /
 * `developer/message`；唯一不产出原子的 surface 类型是 `system/message`——
 *
 * node 0 保护（2026-09-10，dsh 0.1.5 起）：宿主把 system prompt 表示为 surface node 0 的
 * `system/message`，并在 surface.ts `assertSystemHeadRewrite` 里硬性保护——任何覆盖 node 0 的
 * replace 必须是"恰好覆盖该单节点的 system/message"，否则 throw。
 * `system/message` **静默跳过、不产出原子**，因此 node 0 永远不会进入 ARGP 的剪枝区间，
 * 上述宿主断言不会被触发。**这是有意依赖，不是巧合**——若日后要支持剪系统提示，
 * 必须同时改这里与宿主契约。守护用例见 test/argp-graph-engine.test.ts
 * 「system prompt at surface node 0 is never selected for pruning」。
 *
 * `developer/message`（V4 保留类型：tool-addition / tool-removal 块；宿主 ContentBlockMap
 * 注释"providers and UI reject them until their producers and consumers are implemented
 * together"）不像 system head 那样被宿主硬保护，故**显式归类 X**（与 checkpoint 同档）：
 * 进原子台账（手动剪枝段在它处作为**有意边界**断开，见 selectManualRanges），但永不进
 * Stage-1 候选（isMaterial）、永不被剪。宿主若日后激活该类型，边界已在此定义，
 * 而不是一个意外的非原子漏点。
 *
 * 原 class 方法；this.citeStats → host.citeStats（同一对象引用，累计语义不变）。
 */
export function atomize(host, session) {
    const atoms = [];
    for (const seq of session.surface.nodes) {
        const event = sessionEvents(session)[seq];
        if (event === undefined)
            continue;
        const data = event.data;
        const turn = typeof data?.turn === 'number' ? data.turn : 0;
        if (event.type === 'user/message') {
            // P0 分类陷阱防线：先认 data[argp].info（U-info 聚合副本），再判 plugin-source → X
            const kind = classifyUserMessage(data);
            // P4：U-info 投影 sourceSeq（原始用户消息日志 seq）——既是 recall_detail 恢复
            // 目标，也是 isAtomCandidate/闭包 root 的 U-info 识别判据（dialog 无此字段）。
            const uInfoMeta = data?.[ARG_NS];
            const uSourceSeq = typeof uInfoMeta?.sourceSeq === 'number' ? uInfoMeta.sourceSeq : undefined;
            const userAtom = { id: atoms.length, seq, type: kind, turn, text: eventText(session, seq), toolCallIds: [], cites: [], citesFailed: false };
            if (uSourceSeq !== undefined)
                userAtom.sourceSeq = uSourceSeq;
            atoms.push(userAtom);
            continue;
        }
        if (event.type === 'assistant/message') {
            const raw = eventText(session, seq);
            const stored = data.argpCites;
            const parsed = extractCites(raw);
            // 优先用 surface 剥离时存入的 argpCites，保证跨压缩引用图不丢（文本已无 cites）。
            // ⚠ 2026-08-22 修复：判据原查 graded 字段 `c.t`，但写回格式是 ParsedCite `{text, level}`
            // （stripTrailingCitesIfNeeded 存 extractCites 的返回值）→ every 恒 false → 误走 string[]
            // 分支把对象塞进 text → buildGraph cite.text.trim() 抛 TypeError → 压缩静默失败（boundaries=0）。
            // 现按实际格式归一化，兼容 ParsedCite[] / string[]（V5 产物）/ graded {t,l}（契约原文）三种形状。
            let cites;
            if (Array.isArray(stored)) {
                cites = stored
                    .map(c => {
                    if (typeof c === 'string')
                        return { text: c, level: 'supporting' };
                    if (c !== null && typeof c === 'object') {
                        const o = c;
                        const text = typeof o.text === 'string' ? o.text : typeof o.t === 'string' ? o.t : '';
                        if (text === '')
                            return null;
                        let level = 'supporting';
                        const lv = (typeof o.level === 'string' ? o.level : typeof o.l === 'string' ? o.l : '').trim().toLowerCase();
                        if (lv === 'c' || lv === 'critical')
                            level = 'critical';
                        else if (lv === 'x' || lv === 'contextual')
                            level = 'contextual';
                        return { text, level };
                    }
                    return null;
                })
                    .filter((c) => c !== null);
            }
            else {
                cites = parsed.cites;
            }
            const body = parsed.body;
            const msg = data?.message;
            const content = Array.isArray(msg?.content) ? msg?.content : [];
            const toolCallIds = content.filter(b => b.type === 'tool-call' && typeof b.id === 'string').map(b => b.id);
            host.citeStats.aAtoms += 1;
            if (cites.length > 0)
                host.citeStats.declared += cites.length;
            if (parsed.parseFailed)
                host.citeStats.failed += 1;
            atoms.push({ id: atoms.length, seq, type: 'A', turn, text: body, toolCallIds, cites, citesFailed: parsed.parseFailed });
            continue;
        }
        if (event.type === 'tool/result') {
            const d = data;
            const callId = d?.message?.source?.callId;
            atoms.push({ id: atoms.length, seq, type: 'R', turn, text: eventText(session, seq), toolCallIds: callId === undefined ? [] : [callId], cites: [], citesFailed: false });
            continue;
        }
        if (event.type === 'developer/message') {
            // V4 保留类型（tool-addition / tool-removal；宿主尚未激活生产者/消费者）。
            // 显式 X：与 checkpoint 同档——进台账、作手动剪枝的有意边界、永不压缩、永不被剪。
            // 详见函数头注释；守护用例见 test/argp-graph-engine.test.ts「developer/message is
            // classified as X」。
            atoms.push({ id: atoms.length, seq, type: 'X', turn, text: eventText(session, seq), toolCallIds: [], cites: [], citesFailed: false });
            continue;
        }
    }
    return atoms;
}
/**
 * A2 前缀长度守卫（问题 5 修订）：统一按「有效字符」折算——ASCII 1 字符、CJK/全角 2 字符，
 * effective = ascii + wide×2 < minLen（默认 4）即视为噪音前缀（"的""a""the"）→ 不参与匹配。
 * 效果："the"(3 ascii) 拒、"读书"(2 wide = 4) 放行、"the quick"(9 ascii) 放行。
 * 原 class 私有方法（读 this.citeMinPrefixLen）；现 minLen 显式入参。
 */
export function citePrefixTooShort(prefix, minLen) {
    let ascii = 0;
    let wide = 0;
    for (const ch of prefix) {
        if (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch))
            wide += 1;
        else
            ascii += 1;
    }
    return ascii + wide * 2 < minLen;
}
/** A5 倒排索引：prefix n-gram → atom id 候选集（n=3）。索引查询只给候选，命中须过验证谓词。 */
export function buildNGramIndex(atoms, extract) {
    const index = new Map();
    const n = NGRAM_N;
    for (const a of atoms) {
        const text = extract(a);
        if (text === '')
            continue;
        const grams = new Set();
        for (let i = 0; i + n <= text.length; i += 1)
            grams.add(text.slice(i, i + n));
        for (const g of grams) {
            const list = index.get(g);
            if (list === undefined)
                index.set(g, [a.id]);
            else
                list.push(a.id);
        }
    }
    return index;
}
/** 查询候选集：前缀长度 < n 时返回 null（走全扫描回退）。取前缀上 ≤3 个 n-gram 交集收窄候选。 */
export function queryNGramCandidates(index, prefix) {
    const n = NGRAM_N;
    if (prefix.length < n)
        return null;
    const first = prefix.slice(0, n);
    const firstList = index.get(first);
    if (firstList === undefined)
        return [];
    const candidates = new Set(firstList);
    const starts = [Math.floor((prefix.length - n) / 2), prefix.length - n];
    for (const start of starts) {
        if (start === 0)
            continue;
        const g = prefix.slice(start, start + n);
        const list = index.get(g);
        if (list === undefined)
            return [];
        const set = new Set(list);
        for (const id of [...candidates]) {
            if (!set.has(id))
                candidates.delete(id);
        }
        if (candidates.size === 0)
            return [];
    }
    return [...candidates];
}
/**
 * 建图（§4.2 + §4.7 + A1/A2/A5）：确定性边不计级别；cites 子串匹配生成语义边，
 * 级别取声明级别（V6 契约，裸字符串默认 supporting；critical 参与闭包守卫不变量 2′）。
 * A5：3-gram 倒排索引候选（先精确 n-gram 命中，再子串验证）；前缀过短自动全扫描回退。
 * 歧义消解增强（A2）：命中集内 U 优先 → 最长公共前缀最深的原子优先 → 最早 seq。
 * 前缀长度守卫：过短前缀不计 declared 也不建边。
 *
 * 原 class 方法；this.x → host.x（citeStats / lastEdges / lastDeterministicEdges /
 * lastInferredEdges / inferredStats 为同一对象引用，重赋值经 host 落到真实字段）。
 */
export function buildGraph(host, atoms) {
    const edges = [];
    const deterministicEdges = [];
    const rByCall = new Map();
    for (const r of atoms)
        if (r.type === 'R' && r.toolCallIds[0] !== undefined)
            rByCall.set(r.toolCallIds[0], r);
    for (const a of atoms) {
        if (a.type !== 'A')
            continue;
        for (const cid of a.toolCallIds) {
            const r = rByCall.get(cid);
            if (r !== undefined)
                deterministicEdges.push({ from: a.id, to: r.id });
        }
    }
    // A5：整文本 n-gram 索引（子串命中）+ 行首 n-gram 索引（行首精确命中，A2 增强回退）
    const textIndex = buildNGramIndex(atoms, a => a.text);
    const lineIndex = buildNGramIndex(atoms, a => a.text.split('\n').map(l => l.trim()).filter(l => l !== '').join('\n'));
    const resolveHits = (prefix, index, verify) => {
        const candidates = queryNGramCandidates(index, prefix);
        const pool = candidates === null
            ? atoms
            : candidates.map(id => atoms.find(a => a.id === id)).filter((a) => a !== undefined);
        return pool.filter(verify);
    };
    if (!host.disableCiteEdges)
        for (const a of atoms) {
            if (a.type !== 'A')
                continue;
            for (const cite of a.cites) {
                // 兜底防御（2026-08-22）：cites 来自模型不可信输入 + argpCites 历史格式迁移，
                // 任何非字符串 text 一律视为无效声明跳过，绝不让压缩主体抛错。
                if (typeof cite.text !== 'string') {
                    host.citeStats.failed += 1;
                    continue;
                }
                const p = cite.text.trim();
                if (p === '')
                    continue;
                if (citePrefixTooShort(p, host.citeMinPrefixLen)) {
                    host.citeStats.failed += 1; // 过短前缀视为声明失败（保守保护，不建边）
                    continue;
                }
                const selfExcluded = (t) => t.id !== a.id && t.text !== '';
                // 先精确（行首）后子串：行首命中更贴引用意图，其次整文子串（spike 5 教训：includes 兜底）
                let hits = resolveHits(p, lineIndex, t => selfExcluded(t) && t.text.split('\n').some(line => line.trim().startsWith(p)));
                if (hits.length === 0) {
                    hits = resolveHits(p, textIndex, t => selfExcluded(t) && t.text.includes(p));
                }
                if (hits.length === 0)
                    continue;
                let target = hits[0];
                if (hits.length > 1) {
                    host.citeStats.ambiguous += 1;
                    const uHit = hits.find(h => h.type === 'U');
                    if (uHit !== undefined) {
                        target = uHit;
                    }
                    else {
                        // A2：最长公共前缀最深的原子优先（引用意图最接近），同深度取最早 seq
                        const depth = (h) => {
                            let i = 0;
                            while (i < p.length && i < h.text.length && h.text[i] === p[i])
                                i += 1;
                            return i;
                        };
                        target = hits.reduce((min, h) => (depth(h) > depth(min) || (depth(h) === depth(min) && h.seq < min.seq) ? h : min), hits[0]);
                    }
                }
                edges.push({ from: a.id, to: target.id, level: cite.level });
                host.citeStats.resolved += 1;
            }
        }
    // 边价值实验 A₃：合并注入的 oracle 边（离线辅助 LLM 组图）。校验 from/to 合法且非自环。
    // 去重（2026-08-29，citesObligation 退役回复协议后）：模型残留 cites 尾仍会被
    // 上方解析建边，declarer 可能对同一 (from,to) 声明同一条边——只保留先到者
    // （回复级逐字前缀是最强证据），防 inDegree 双计污染判决与守卫计数。
    if (host.injectEdges !== undefined) {
        const validIds = new Set(atoms.map(a => a.id));
        const seen = new Set(edges.map(e => `${e.from}\u0000${e.to}`));
        for (const e of host.injectEdges(atoms)) {
            if (e.from === e.to || !validIds.has(e.from) || !validIds.has(e.to))
                continue;
            const key = `${e.from}\u0000${e.to}`;
            if (seen.has(key))
                continue;
            seen.add(key);
            edges.push(e);
        }
    }
    // v1.2.0 组件 A（PROPOSAL-token-ontology）：推断边——承重 token 逐字包含派生
    // （0 LLM，I-A1 构造性；停词过滤/每 A 上限/声明窗口见 token-ontology.ts）。
    // 在 cites / injectEdges 之后合并 → 声明边先行（同 (from,to) 先到者胜，与 inject
    // 去重同纪律）；A₁ 臂（disableCiteEdges）一并隔离，保零语义边实验语义。
    host.lastInferredEdges = [];
    if (!host.disableCiteEdges && !host.disableInferredEdges) {
        const pairs = deriveInferredEdges(atoms, host.inferredOpts);
        host.inferredStats.candidates = pairs.length;
        const seqToId = new Map();
        for (const a of atoms)
            seqToId.set(a.seq, a.id);
        const seenInferred = new Set(edges.map(e => `${e.from}\u0000${e.to}`));
        let accepted = 0;
        let skippedDup = 0;
        for (const p of pairs) {
            const from = seqToId.get(p.fromSeq);
            const to = seqToId.get(p.toSeq);
            if (from === undefined || to === undefined)
                continue;
            if (from === to)
                continue; // 防御：seq→id 映射异常（如重复 id）不得产出自环
            const key = `${from}\u0000${to}`;
            if (seenInferred.has(key)) {
                skippedDup += 1;
                continue;
            }
            seenInferred.add(key);
            edges.push({ from, to, level: 'inferred' });
            host.lastInferredEdges.push({ from, to, level: 'inferred' });
            accepted += 1;
        }
        host.inferredStats.accepted = accepted;
        host.inferredStats.skippedDup = skippedDup;
    }
    host.lastEdges = edges;
    host.lastDeterministicEdges = deterministicEdges;
    const inDegree = new Map();
    for (const e of edges)
        inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1);
    return { edges, deterministicEdges, inDegree };
}
/** A4 行级重叠相似度：sim=|A∩B|/min(|A|,|B|)（行集合）。原 class 私有 static 方法。 */
export function lineOverlap(a, b) {
    const linesA = new Set(a.split('\n').map(l => l.trim()).filter(l => l !== ''));
    const linesB = new Set(b.split('\n').map(l => l.trim()).filter(l => l !== ''));
    const min = Math.min(linesA.size, linesB.size);
    if (min === 0)
        return 0;
    let inter = 0;
    for (const l of linesA)
        if (linesB.has(l))
            inter += 1;
    return inter / min;
}
/**
 * §4.4 版本链去重（+ A3 N1 bug fix + A4 θ 重叠归链）：
 *  - A：文本全等（不变）。
 *  - R：按「issuer A 的 tool name + arguments JSON」去重（而非旧版 issuer?.text.trim()），
 *    解决「同措辞不同工具调用（如不同参数 read different files）被错误归链去重」的问题。
 *    回退：issuer 不存在时用 r.text（callId 缺失的最小退化）。
 *  - A4：enableOverlapChain 时，R 文本行重叠 sim ≥ θ（默认 0.8）也归入同一版本链
 *    （read→edit→read 等高频工具迭代）；A 文本仍走全等。
 * 返回 { dupIds, chainLen }：chainLen 记录每个存活代表（newer）的链长，供 density-chain 叠加 eff。
 *
 * 原 class 私有方法；this.session → host.session，this.enableOverlapChain/overlapTheta → host.*。
 */
export function findVersionDuplicates(host, atoms, inDegree) {
    const dupIds = new Set();
    const chainLen = new Map();
    const latestRByKey = new Map();
    const rKeyByRId = new Map();
    const issuerByCall = new Map();
    const rByCall = new Map();
    for (const a of atoms) {
        if (a.type !== 'A')
            continue;
        for (const cid of a.toolCallIds)
            issuerByCall.set(cid, a);
    }
    for (const r of atoms) {
        if (r.type !== 'R' || r.toolCallIds[0] === undefined)
            continue;
        rByCall.set(r.toolCallIds[0], r);
    }
    const addPair = (a) => {
        if ((inDegree.get(a.id) ?? 0) !== 0)
            return;
        // 方案 A 修复（2026-08-23）：剪 A 时无条件连带剪其全部 R，与 pass 循环（:1693 附近）语义一致。
        // 版本去重语义 = 旧快照整组淘汰；R 的 cites 引用在 newer 版本上会重建，旧 R 与引用一起剪。
        // 不保护被 cites 的旧 R（否则 surface 膨胀、版本链去重失效）；无孤儿由连带剪保证。
        dupIds.add(a.id);
        for (const cid of a.toolCallIds) {
            const r = rByCall.get(cid);
            if (r !== undefined)
                dupIds.add(r.id);
        }
    };
    const seenA = new Map();
    for (const a of atoms.filter(x => x.type === 'A')) {
        const key = a.text.trim();
        const existing = seenA.get(key);
        if (existing !== undefined) {
            const older = existing.atom.turn < a.turn || (existing.atom.turn === a.turn && existing.atom.seq < a.seq) ? existing.atom : a;
            const newer = older === existing.atom ? a : existing.atom;
            if ((inDegree.get(older.id) ?? 0) === 0)
                addPair(older);
            const count = existing.count + 1;
            chainLen.set(newer.id, count);
            seenA.set(key, { atom: newer, count });
        }
        else {
            seenA.set(key, { atom: a, count: 1 });
        }
    }
    const seenR = new Map();
    const rKey = (r) => {
        // A3 N1 fix：R 去重键 = issuer A 的 tool name + arguments JSON（callId 缺失时退化为 r.text）
        const issuer = r.toolCallIds[0] !== undefined ? issuerByCall.get(r.toolCallIds[0]) : undefined;
        if (issuer === undefined)
            return 'text|' + r.text.trim();
        const issuerEvent = host.session === null ? undefined : sessionEvents(host.session)[issuer.seq];
        const content = issuerEvent?.data
            ?.message?.content;
        const tc = content?.find(b => b.type === 'tool-call' && b.id === r.toolCallIds[0]);
        const argsStr = tc !== undefined && tc.arguments !== undefined
            ? (typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments))
            : '';
        return (tc?.name ?? '?') + '|' + argsStr;
    };
    const registerR = (key, r) => {
        const list = seenR.get(key);
        if (list === undefined)
            seenR.set(key, [{ atom: r }]);
        else
            list.push({ atom: r });
        latestRByKey.set(key, r.seq);
        rKeyByRId.set(r.id, key);
    };
    const mergeOlderR = (older, r, key) => {
        if ((inDegree.get(older.id) ?? 0) === 0) {
            dupIds.add(older.id);
            const issuer = older.toolCallIds[0] !== undefined ? issuerByCall.get(older.toolCallIds[0]) : undefined;
            if (issuer !== undefined)
                addPair(issuer);
        }
        // A4 问题 4 修订：chainLen = 合并后组成员数（list.length），而非「已合并条目数+1」的
        // cur.count 累加——后者在同一 atom 已入 list 时重复多计（如 3 副本 R 链混入 issuer A 计数）。
        // 先 push 再取 list.length：3 个相同 R → 第一次 register len=1，随后两次 merge 各 push → len=2/3。
        const list = seenR.get(key);
        if (list === undefined) {
            seenR.set(key, [{ atom: r }]);
            chainLen.set(r.id, 1);
        }
        else {
            list.push({ atom: r });
            chainLen.set(r.id, list.length);
        }
        // 版本链重定向：记录该 key 下最新见到的 R seq（遍历按 surface 顺序，后续 seq 更大更「新」）
        latestRByKey.set(key, r.seq);
        rKeyByRId.set(older.id, key);
        rKeyByRId.set(r.id, key);
    };
    for (const r of atoms.filter(x => x.type === 'R')) {
        const key = rKey(r);
        const group = seenR.get(key);
        const exact = group?.find(e => e.atom.text === r.text);
        if (exact !== undefined) {
            const older = exact.atom.turn < r.turn || (exact.atom.turn === r.turn && exact.atom.seq < r.seq) ? exact.atom : r;
            const newer = older === exact.atom ? r : exact.atom;
            if (older !== newer) {
                mergeOlderR(older, newer, key);
                exact.atom = newer;
            }
            continue;
        }
        if (host.enableOverlapChain && group !== undefined) {
            const sims = group.map(e => lineOverlap(e.atom.text, r.text));
            const best = sims.reduce((m, s, i) => (s > sims[m] ? i : m), 0);
            if (sims[best] !== undefined && sims[best] >= host.overlapTheta) {
                const older = group[best]?.atom;
                mergeOlderR(older, r, key);
                continue;
            }
        }
        registerR(key, r);
    }
    return { dupIds, chainLen, latestRByKey, rKeyByRId };
}
