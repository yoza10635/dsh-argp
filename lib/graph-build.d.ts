/**
 * ARGP 建图模块（P5 结构重构 Wave 3 第 4 步，C 报告 §4 A 表）。
 *
 * 从 3,380 行 hub `argp-graph-engine.ts`（God Class）拆出的**建图侧**函数：
 * 原子化（atomize）+ 建图（buildGraph）+ 版本链去重（findVersionDuplicates）
 * + cites 提取（extractCites）+ user 分类（classifyUserMessage）+ 它们的纯辅助
 * （looksAskText / citePrefixTooShort / n-gram 索引 / lineOverlap）。
 *
 * 循环 import 规避（C 报告关键设计决策 1）：本模块**不** import hub 运行时。
 * 需要读/写引擎可变字段的函数（atomize / buildGraph / findVersionDuplicates）
 * 接收窄接口 {@link GraphBuildHost} 而非具体 class；hub 的 class 以
 * `this as unknown as GraphBuildHost` 传入（编译期断言，运行时即真实实例，
 * 私有字段经 host 类型可读写/重赋值）。依赖方向：hub → graph-build（单向）。
 *
 * 行为逐字节不变：函数体逻辑逐字保留（this.x → host.x），仅 `this` 换 `host`。
 */
import type { Session } from '@deepseek-ai/dsh-session';
import type { Atom, SemanticEdge, DeterministicEdge } from './argp-types.js';
import type { ParsedCite } from './cites-strip.js';
import { type InferredEdgeOptions } from './token-ontology.js';
/** cites 服从率度量台账（C7-cites 判决用）。 */
export interface CiteStats {
    aAtoms: number;
    declared: number;
    resolved: number;
    ambiguous: number;
    failed: number;
}
/** 推断边统计（v1.2.0；最近一次 buildGraph 口径，每次建图重置；skippedDup = 与既有声明边同 (from,to) 被去重）。 */
export interface InferredStats {
    candidates: number;
    accepted: number;
    skippedDup: number;
}
/**
 * 建图侧模块函数访问引擎状态所需的窄接口（C 报告关键设计决策 1）。
 * 仅列出 atomize / buildGraph / findVersionDuplicates 实际读写的字段；
 * hub 的 ArgpGraphEngine 以 `this as unknown as GraphBuildHost` 满足它。
 */
export interface GraphBuildHost {
    session: Session | null;
    citeStats: CiteStats;
    citeMinPrefixLen: number;
    disableCiteEdges: boolean;
    injectEdges: ((atoms: Atom[]) => SemanticEdge[]) | undefined;
    disableInferredEdges: boolean;
    inferredOpts: InferredEdgeOptions;
    lastInferredEdges: SemanticEdge[];
    inferredStats: InferredStats;
    lastEdges: SemanticEdge[];
    lastDeterministicEdges: DeterministicEdge[];
    enableOverlapChain: boolean;
    overlapTheta: number;
}
/**
 * A8（问题 10 修订）：ask 检测中英双语纯函数。
 * 英文：'?' / ask / what；中文：？/ 吗 / 呢 / 什么 / 怎么 / 如何 / 能否 / 能不能。
 * /帮我/ 由子串收窄为句首（^请|^帮我|^能不能|^能否），避免 "顺便帮我带个话" 之类
 * 非问句/非请求主语误命中；疑问词 什么/怎么/如何 仍保留子串（问句核心成分，方向保守=少剪）。
 * 导出供测试直接锁定收窄行为。
 */
export declare function looksAskText(text: string): boolean;
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
export declare function classifyUserMessage(data: unknown): 'U' | 'X';
/**
 * 提取 A 文本尾部的 cites JSON（支持裸 JSON 与 ```json 围栏）；返回剥离后正文与引用列表。
 * V6 分级契约：条目可为字符串（视为 supporting）或 {t, l} 对象（l ∈ c|s|x）。
 * 形状不合法（如混入数字/对象缺 t）→ parseFailed 保守保护。
 */
export declare function extractCites(text: string): {
    body: string;
    cites: ParsedCite[];
    attempted: boolean;
    parseFailed: boolean;
};
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
export declare function atomize(host: GraphBuildHost, session: Session): Atom[];
/**
 * A2 前缀长度守卫（问题 5 修订）：统一按「有效字符」折算——ASCII 1 字符、CJK/全角 2 字符，
 * effective = ascii + wide×2 < minLen（默认 4）即视为噪音前缀（"的""a""the"）→ 不参与匹配。
 * 效果："the"(3 ascii) 拒、"读书"(2 wide = 4) 放行、"the quick"(9 ascii) 放行。
 * 原 class 私有方法（读 this.citeMinPrefixLen）；现 minLen 显式入参。
 */
export declare function citePrefixTooShort(prefix: string, minLen: number): boolean;
/** A5 倒排索引：prefix n-gram → atom id 候选集（n=3）。索引查询只给候选，命中须过验证谓词。 */
export declare function buildNGramIndex(atoms: Atom[], extract: (a: Atom) => string): Map<string, number[]>;
/** 查询候选集：前缀长度 < n 时返回 null（走全扫描回退）。取前缀上 ≤3 个 n-gram 交集收窄候选。 */
export declare function queryNGramCandidates(index: Map<string, number[]>, prefix: string): number[] | null;
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
export declare function buildGraph(host: GraphBuildHost, atoms: Atom[]): {
    edges: SemanticEdge[];
    deterministicEdges: DeterministicEdge[];
    inDegree: Map<number, number>;
};
/** A4 行级重叠相似度：sim=|A∩B|/min(|A|,|B|)（行集合）。原 class 私有 static 方法。 */
export declare function lineOverlap(a: string, b: string): number;
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
export declare function findVersionDuplicates(host: GraphBuildHost, atoms: Atom[], inDegree: Map<number, number>): {
    dupIds: Set<number>;
    chainLen: Map<number, number>;
    latestRByKey: Map<string, number>;
    rKeyByRId: Map<number, string>;
};
