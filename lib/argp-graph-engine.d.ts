import type { Context } from '@deepseek-ai/cordis';
import { CompactionEngine } from '@deepseek-ai/dsh-compaction';
import type { CompactionAgentContext, CompactionResult, CompactionTrigger, ManualCompactAgentContext } from '@deepseek-ai/dsh-compaction';
import type { Session } from '@deepseek-ai/dsh-session';
import type { CommandId } from '@deepseek-ai/dsh-commands/brand';
import type { NodeState as NodeStateLabel } from './log-access.js';
export type { NodeState, LogRow, LogRowType } from './log-access.js';
import type { ParsedCite } from './cites-strip.js';
export type { ParsedCite, CiteLevel } from './cites-strip.js';
import { type InferredEdgeOptions } from './token-ontology.js';
import { type PresetCleanOptions } from './preset-cleaner.js';
export type { PresetCleanOptions, PresetCleanReport, PresetRow } from './preset-cleaner.js';
import { PeratomCompressor, type PeratomCompressorConfig } from './peratom/compressor.js';
import { CiteDeclarer, type CiteDeclarerConfig } from './peratom/cite-declarer.js';
import { RecallZoom, type RecallZoomConfig } from './peratom/recall-zoom.js';
import z from '@deepseek-ai/schemastery';
/**
 * UI 设置页可调旋钮（Settings → Plugins → Configurable → ARGP）。
 * 服务端经 ctx.inject(['settings']) → settings.register('dsh-argp', schema, { base })
 * 注册 namespace，base=引擎 cordis 配置；客户端 ArgpConfigCard 经 ctx.settingsScope.bind 读写。
 * 字段即引擎构造期读取的顶层旋钮。
 */
export interface ArgpUserSettings {
    windowRatio: number;
    retainRatio: number;
    maxPasses: number;
    recencyGuard: number;
    turnGuard: number;
    minSpanChars: number;
    enableSummarize: boolean;
    sortMode: 'legacy' | 'density' | 'density-chain';
    charsPerToken: number;
}
/** 设置页 namespace key（同时是 Host 服务端与客户端卡片的 key，须一致才进渲染交集）。 */
export declare const ARG_SETTINGS_KEY = "dsh-argp";
/** 引擎设置 schema（schemastery）：校验 UI 写入 + 提供 describe 视图。默认值=引擎既有默认。 */
export declare const ArgpUserSettingsSchema: z<ArgpUserSettings>;
export type AtomType = 'U' | 'A' | 'R' | 'X';
export interface Atom {
    id: number;
    seq: number;
    type: AtomType;
    turn: number;
    text: string;
    toolCallIds: string[];
    cites: ParsedCite[];
    citesFailed: boolean;
    /**
     * P4（U-info 剪枝放行）：仅 U-info 聚合副本有值——原始用户消息的日志 seq
     * （recall_detail(sourceSeq) 的恢复目标）。dialog 副本（无 argp meta）与
     * 普通 user 消息均无此字段，故 `sourceSeq !== undefined` 即 U-info 识别判据：
     * ① isAtomCandidate 按 R 待遇参剪；② 排除出闭包 root（防 U-info 误当
     * task-init 根拖整段退休）。
     */
    sourceSeq?: number;
}
/**
 * 语义边级别。v1.2.0 起含 'inferred'（PROPOSAL-token-ontology 组件 A）：
 * 承重 token 逐字包含派生边——模型声明通道（cites / declarer）空窗时的**保底层**，
 * 0 LLM、构造性 I-A1（∃ token 双端逐字在场）。保护度低于任何声明档（权重 1 < contextual 2），
 * 高于无边原子；声明边先行去重（buildGraph 在 cites/inject 之后合并，同 (from,to) 先到者胜）。
 */
export type EdgeLevel = 'critical' | 'supporting' | 'contextual' | 'inferred';
export interface SemanticEdge {
    from: number;
    to: number;
    level: EdgeLevel;
}
export interface DeterministicEdge {
    from: number;
    to: number;
}
export declare const EDGE_WEIGHTS: Record<EdgeLevel, number>;
/** 比例预算纯函数：window = ctx × windowRatio；retain = window × retainRatio（缺省回退）。导出供测试。 */
export declare function scaleBudgets(contextWindow: number | undefined, opts: {
    windowRatio?: number;
    retainRatio?: number;
    explicitWindow?: number;
    explicitRetain?: number;
    fallbackWindow?: number;
    fallbackRetain?: number;
}): {
    windowTokens: number;
    retainTokens: number;
};
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
 * 插件 append，但必须按 U 待遇参与剪枝候选），再落 `source.kind === 'plugin'` → X
 * （墓碑/checkpoint）判定。若先判 plugin-source，U-info 会被分类成 X 而**全局不可剪**，
 * P4 的候选放行将永远失效。
 *
 * 此前该规则内联在四处（catalogText / recallQuery / atomize / rebuildLedgerFromLog），
 * 现统一收敛到本纯函数；导出供测试直接锁定顺序行为（A8 先例）。
 */
export declare function classifyUserMessage(data: unknown): 'U' | 'X';
/**
 * tombstone 可合并判据（v1.2.x §11.8① 修复）。X 原子中仅「本引擎剪枝墓碑」可安全合并：
 * 文本以 `[elided` 开头、含 pruned by ARGP 与 recall_pruned 取回提示（覆盖默认区间
 * 墓碑与 closure 墓碑两种形态；tool 占位墓碑 `[elided: ...` 缺 pruned by ARGP → 不合并，
 * 且 consolidateTombstoneRuns 只认 user/message 事件，双保险防孤儿 tool_calls）。
 * 其余 X（宿主 system-reminder、官方摘要 checkpoint、注入型 checkpoint）不可动。
 * 导出供测试锁定行为。
 */
export declare function isMergeableTombstone(text: string): boolean;
export interface ArgpGraphConfig {
    /** 触发线（token）。不传时默认 = 适配器声明的 contextWindow × windowRatio（默认 0.8）。 */
    windowTokens?: number;
    /** 保留目标（token）。不传时默认 = 触发线 × retainRatio（默认 0.2，压缩率 1/5）。 */
    retainTokens?: number;
    /** 触发线占上下文比例（默认 0.8；仅当 windowTokens 未显式指定时生效）。 */
    windowRatio?: number;
    /** 保留目标占触发线比例（默认 0.2；仅当 retainTokens 未显式指定时生效）。 */
    retainRatio?: number;
    recencyGuard?: number;
    turnGuard?: number;
    /**
     * 轮中（step > 1）压力剪开关（三级触发 v1.5.0）。默认 **true**。
     *
     * 动机（2026-09-21 真会话存档实证）：上下文超限的两个主要形态是「拿到 tool result 之后
     * 才超」与「输出被钳制」——前者发生在**轮中**，而只在轮初判定的 L1 看不到它。轮中不剪
     * ⇒ 只能等 provider 400（浪费一次请求）或等输出被钳（本 turn 直接被 max-tokens 终结）。
     * 轮中剪的落地位置是那个 pre-step，剪完**同一个 step 的请求**即已瘦身 ⇒ 天然自动继续。
     *
     * ⚠️ 与 1.3.x 的关键差别：轮中剪**放宽 `turnGuard`**（见 `midTurnTurnGuard`）。超额的来源
     * 就是**本轮**的 tool result，而 turnGuard=1 恰把整轮保护起来——这正是 1.3.x 轮中剪"只剪
     * 掉 1 原子/154 tok、却每次都断一次前缀缓存"的根因。轮中剪**不跑 per-atom LLM pass**
     * （那是 79s–3min 的阻塞，轮中不划算；0-LLM 图剪放宽守卫即可剪掉本轮旧 tool result）。
     *
     * 兼容别名（1.4.0 起）：`midTurnActive: true` = 轮中剪**开**且用默认守卫（1.3.x 语义，
     * 对照组）；`midTurnActive: false` = 轮中剪**关**（1.4.0 语义）。两者都不写 = 新默认。
     */
    midTurnPrune?: boolean;
    /** 轮中剪时 `turnGuard` 降到该值（默认 0 = 允许剪本轮的旧 A/R；`recencyGuard` 照常保护最新节点）。 */
    midTurnTurnGuard?: number;
    /** 1.4.0 的旧键：见 `midTurnPrune` 的兼容别名说明。 */
    midTurnActive?: boolean;
    /**
     * 输出被钳制后自动续写的提示词（三级触发 v1.5.0）。默认内置中文一句（点明"输出被宿主的
     * 输出预算截断 + 上下文已压缩 + 接着上次未完成处写、勿重述"）。设为空串则只剪枝不续写。
     */
    continuationNotice?: string;
    /**
     * 反应式补救的最大次数（**每次"连续被钳"episode** 内，默认 2；出现一次正常输出即清零）。
     * 输出被外部钳制后（`finish=max-tokens` 且 `usage.outputTokens < 本次请求的 maxTokens`，
     * = provider/适配器把输出预算啃小了，容量压力的真信号）：
     *   ① 若本 turn 随后要结束（`agent/turn-stopping`）⇒ 就地强制剪 + `steer` 一条续写消息，
     *      把**当前轮**续下去（1.5.0 核心：被钳不再等于任务中断）；
     *   ② 否则（turn 还在跑）⇒ 下一个 pre-step 强制剪。
     * 第 2 次起放宽 `recencyGuard`/`turnGuard`（连最新节点一起剪）。用尽后不再重试，交给
     * overflow 路径（provider 400）兜底——避免"每步都被钳 → 每步白压"的死循环。
     */
    reactiveRetries?: number;
    minSpanChars?: number;
    charsPerToken?: number;
    /** 单次剪枝事务的最大贪心 pass 数（默认 16；生产档大批量剪枝应调高）。 */
    maxPasses?: number;
    /** 触发保留余量（token）；默认 0。windowTokens 会先减去该值作为触发线。 */
    reserveTokens?: number;
    /** 可选显式 token 测量函数；不传则退化为字符估算。 */
    measureTokens?: (session: Session) => {
        contextTokens: number;
        surfaceTokens: number;
    };
    /** 是否启用 summarize 降级。默认 false：本地单 slot 模型下 summarize 会破坏 KV cache，ARGP 走 force_prune。 */
    enableSummarize?: boolean;
    /** 降级链：lifecycle（默认，闭包→force） / summarize / force / fail。 */
    degradationStrategy?: 'lifecycle' | 'summarize' | 'force' | 'fail';
    /** 排序模式（spike 18 提案，2026-08-23 起默认 density）：
     *  density（默认）：eff 同档内 token 降序（大 token 先剪，单位 token 重要性；spike 19 实证同达成度 recall 2→0）
     *  legacy： [lvl, eff, lastRef, seq]（绝对 eff，忽略体积；显式传入以回退旧行为）
     *  density-chain：density + 版本链存活代表 eff 叠加 (count-1)*1 */
    sortMode?: 'legacy' | 'density' | 'density-chain';
    /**
     * latestTurn 口径（P4 修复）：
     *  semantic（默认）：只算真实 U/A/R 活动的 turn；注入型 X 节点（system-reminder、
     *    ARGP 自己的 tombstone）不推进轮次计数，避免"注入撑大 latestTurn → 闭包保护
     *    窗口 latestTurn-k 被抬高 → 本应受保护的旧闭包被提前剪"。
     *  all：旧口径，把 X 一并算进 latestTurn（既往实验数据基线；对照实验需显式指定）。
     * 注意：本项影响 turnGuard 与闭包保护窗口的判定，口径变更需在实验台账标注。
     */
    turnBasis?: 'semantic' | 'all';
    /**
     * 上下文溢出恢复的最大重试次数（context-overflow trigger）。缺省口径（2026-08-29
     * review 修复）：未挂 peratom compressor 时默认 1（对齐官方 compaction-basic）；
     * 挂载时自动提到 3——否则三步序列的第②步（事件#2）在重试上限守卫处被跳过，
     * 溢出三步退化为"① + 保留错误"。显式配置始终优先。每次「模型请求 400
     * exceed_context_size → 恢复步 → retry」消耗 1 次；超限后保留原始请求错误。
     */
    maxOverflowRetries?: number;
    /** 闭包静止窗 K（默认 2）：lastRef 须 ≤ latestTurn−K 且未被 recall 防抖才可整闭包剪除。 */
    closureWindowK?: number;
    /** cites 前缀最小长度守卫（A2，默认 2）：前缀字符数低于该值直接判失败，避免"的/a"等噪音伪引用。 */
    citeMinPrefixLen?: number;
    /** 版本链重叠归链阈值 θ（A4，默认 0.8，仅对 R 生效）：sim=|A∩B|/min(|A|,|B|) ≥ θ 视为同一版本链。 */
    overlapTheta?: number;
    /** 版本链重叠归链启用（A4，默认 false；启用后 A 文本仍走全等去重）。 */
    enableOverlapChain?: boolean;
    /**
     * 边价值实验 A₃：注入 oracle 边（离线辅助 LLM 组图，schema 强制）。
     * buildGraph 在 cites 边之后合并这些边，用于测"理论上限"保留集（A₃−A₂ = 模型服从率吃掉的价值）。
     */
    injectEdges?: (atoms: Atom[]) => SemanticEdge[];
    /**
     * 边价值实验 A₁ 离线重放：跳过 cites 边构建（仅保留确定性 A→R 边），
     * 隔离"无边"保留集，与 A₂（带 cites 边）比 shadowedSeqs 差异（P1 结构层）。
     * 注意（v1.2.0）：A₁"无边"臂同时**自动隔离推断边**——disableCiteEdges=true 时
     * 推断边一并关闭，保证该臂零语义边的实验语义不被 0-LLM 派生边污染。
     */
    disableCiteEdges?: boolean;
    /**
     * 推断边开关（PROPOSAL-token-ontology 组件 A，v1.2.0；默认 true = 启用）。
     * 承重 token 逐字包含派生语义边（0 LLM、建图期）：模型声明通道空窗时恢复选择性，
     * 保护集只增不减（I-A4）。false = 退回 v1.1 行为（语义边仅 cites / inject 两源）。
     * 独立于 disableCiteEdges（A₁ 臂经后者一并关闭，见上）。
     */
    disableInferredEdges?: boolean;
    /** 推断边种子 token 最小长度（默认 6；守卫词表 ≥4 为保真口径，边派生需更强区分度）。 */
    inferredMinTokenLen?: number;
    /** 推断边停词阈值（默认 0.15）：出现在 >15% 原子中的 token 不派生边。 */
    inferredStopwordRatio?: number;
    /** 每 A 原子推断边上限（默认 8）。 */
    inferredMaxEdgesPerAtom?: number;
    /** 推断边声明窗口轮数（默认 20）：仅近 N 轮的 A 原子作边源。 */
    inferredWindowTurns?: number;
    /**
     * tombstone 归并阈值（v1.2.x §11.8① 修复，默认 8；0 = 关闭）。
     * X 原子（剪枝墓碑）在 isAtomCandidate 结构性不可剪 → 墓碑地板单调累积，
     * 实测两臂复现同形态 CONTEXT_WINDOW_EXCEEDED（141,313+32,768>174,080；
     * run2 T16 dump：1297/1310 surface 节点是墓碑，284,786 chars ≈ 142K tok）。
     * ≥N 的连续可合并墓碑段会被归并为单条聚合墓碑（原文仍在 append-only 日志，
     * recall_pruned(seq) 可取回）。每 pass 至多归并一段——若整段一次事务 replace
     * 失败，回退范围清晰可查（宁少并不错删）。
     */
    tombstoneMergeMinRun?: number;
    /**
     * P0 双引擎生产挂载（2026-08-28，webui-liaison 台账发现一，已迁出公开仓库）：非空时
     * 引擎构造期自挂 peratom 三管线（Stage-1 eager 熵降 + 边声明 + 两级召回），
     * injectEdges/onOverflowCompress 由内部接线——显式传入的同名 config 键被忽略并告警。
     * 管线组件的 llm 后端：component config 传 `llm: { provider, model }` 走宿主 dsh-llm
     * （生产形态，purpose='compaction'）；不传按各组件 fetch 环境变量口径解析（本地实验
     * 形态，环境缺失时组件自然 disabled，零网络）。`false` = 关闭该管线。
     * 与 mountPeratomStack（测试/三臂工厂）同拓扑；本块存在的意义是真宿主 bundle patch
     * 只能声明式挂一个插件入口（发现一：default export 只有 graph 引擎 = 双引擎无生产路径）。
     */
    peratom?: {
        compressor?: PeratomCompressorConfig | false;
        declarer?: CiteDeclarerConfig | false;
        zoom?: RecallZoomConfig | false;
    };
    /**
     * Preset 净化器（2026-09-04 Q8 收口）。rc.2 起 agent 组成迁入 preset 平面，
     * standard/cordis/ptc 的 compaction 组各挂一份 compaction-basic——宿主 profile 的
     * `disabled: true` 管不到 preset 子树，官方摘要器与 ARGP 双引擎并存（外来 lossy
     * 摘要先于图剪 + 英文 checkpoint 拉偏会话语言）。启用后引擎挂载期对 roster 中每个
     * 含 stock compaction 的 shipped preset 经官方 authoring API 生成净化副本
     * `<id>-argp`（摘除 compaction-basic/tool-result-pruner，保留 command-compact——
     * 其 `compaction` inject 沿 realm 链向上解析到本引擎的 `ctx.compaction`，
     * `/compact` 自动指向 ARGP 图剪）。幂等、fail-soft、只写 `~/.dsh/.agent-presets/`。
     * `false` 关闭；对象可调 strip 集合/后缀/源白名单（见 PresetCleanOptions）。
     * 依赖 roster 服务：无 agentPresets 的部署（headless 等）静默跳过。
     */
    presetClean?: false | PresetCleanOptions;
    /**
     * 回复级 cites 义务开关（argp-cites system section，order 151）。
     * 缺省 auto：declarer 管线挂载且已武装（解析到 LLM 后端）时关闭，否则开启——
     * 边声明由 declarer 结构化旁路承担，主回复不再携带 {"cites":...} 尾（源头消灭
     * UI 显示泄漏，见 webui-liaison 台账发现三证据链，已迁出公开仓库）。
     * 2026-09-21 时序修复：auto 兜底（autoLlm）的 declarer 构造期未武装、会话中期
     * 才经 agent/status 武装——auto 口径下 section 恒注册，text 回调在 armed 翻转后
     * 动态返回 ''（renderPrompt 过滤空 section ⇒ system 块不再含协议）；armed 单调
     * 递增 ⇒ 至多翻转一次。显式 true/false 覆盖 auto（静态语义不变）：边价值实验
     * A₁-A₃ 臂依赖回复级 cites 时强制开；双保险关闭时强制关。declarer 挂载但始终
     * 未武装（无 LLM 后端）时 auto 保持全文（两种边来源不能同时归零）。buildGraph
     * 的 cites 解析不受影响——协议关闭后模型偶发残留的 cites 尾仍被剥离并作为加菜
     * 边消费，引擎侧 flush 剥离恒开。
     */
    citesObligation?: boolean;
    /**
     * P4 溢出三步序列第 ② 步：第一次溢出 forcePrune 后若仍超窗，
     * 回调对当前 open turn 做 per-atom 降熵（PeratomCompressor.compressOpenTurn：
     * U 拆分 / 大 R extract + 顺带补 cites），产生 surface 换代后由第 ③ 步
     * 再次 forcePrune 收尾。未注入（undefined）时退化为现役两步
     * （forcePrune → 保留原错误），行为与 0.3.x 完全一致。
     * 回调自身失败被吞掉（失败隔离：不影响后续 forcePrune 与原错误保留）。
     */
    onOverflowCompress?: (session: Session) => Promise<void>;
    /**
     * P6 轮内压力压缩（2026-09-19 方案 B 主路径）：pre-step 压力达标（与
     * compactIfNeeded('pressure') 同口径）时，**先**对当前 open turn 做 per-atom
     * 压缩（compressOpenTurn），**再**图剪（compactIfNeeded），两者在同一 pre-step
     * 窗口落地 = 单变异窗口（"拼回"效果：step k+1 看到剪枝后 turns 1..N-1 +
     * 原子压缩过的进行到一半的 turn N）。仅 open turn 触发（闭合轮走 idle 边界
     * 路径）；活跃态守卫内建——pre-step 在轮内只在 tool result 之后触发，纯文本
     * 收手的 turn 不会再 fire。回调自身失败被吞掉（失败隔离：不影响后续图剪）。
     * 未注入（undefined）时行为与 P6 前完全一致（仅溢出才压 open turn）。
     */
    onPrePressureCompress?: (session: Session) => Promise<void>;
}
export interface GraphPruneRecord {
    at: string;
    compactionId: string;
    /** /compact 发起命令 ID（presentation correlation；自动压缩时为 undefined）。 */
    sourceCommandId?: string;
    intervals: {
        start: number;
        end: number;
        tombstoneSeq: number;
    }[];
    startEventSeq: number;
    summaryEventSeq: number;
    endEventSeq: number;
    shadowedSeqs: number[];
    prunedAtoms: {
        id: number;
        type: AtomType;
        seq: number;
    }[];
    semanticEdges: number;
    candidates: number;
    charsBefore: number;
    charsAfter: number;
    forced: boolean;
}
/** 从一个事件投影出模型可见文本（text + tool-call 概要 + tool-result 内层 text；reasoning 不算）。 */
export declare function eventText(session: Session, seq: number): string;
/**
 * 流式中 assistant 消息落盘后，立即剥离尾部 {"cites":[...]}（ARGP 引用协议产物），
 * 使其不残留在**模型可见 surface** 上——下一轮请求不再把协议产物当正文重读。
 * 注意（2026-08 修正认知）：Web UI 的人类转录按 dsh 核心设计固定取 append 起源
 * 事件，replace 副本是 model-only（core session surface.ts："replacement copies
 * stay model-only"），因此本剥离**不影响 UI 显示**。UI 侧残留的治理在源头：
 * cites 契约 V5 规定空引用时不产出任何 block（空块对引用图零信息）；非空 block
 * 在 UI 中作为原始回复的一部分可见（模型侧仍被剥离）。仅改写最后一个 text 块；
 * 保留 model/provider/replay 等元数据；将 cites 存入 data.argpCites，以便后续
 * compaction 经 atomize 重建引用图（文本被剥离后 extractCites 取不到 cites）。
 * 幂等：已剥离节点（含 argpCites）再次进入时直接跳过，无重入循环。
 */
export declare function stripTrailingCitesIfNeeded(session: Session, event: {
    seq: number;
    data?: Record<string, unknown>;
}): void;
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
/** list_pruned 工具的剪枝节点目录条目。 */
export interface PrunedNodeInfo {
    seq: number;
    type: AtomType;
    turn: number;
    firstLine: string;
    citedBySeq: number[];
    /** 被剪瞬间的有效重要性（recall 价值继承的来源，§3-3）。 */
    eff: number;
    /** 版本链重定向（2026-08-23）：被剪旧快照 recall 时，指向同一路径（tool name+arguments）下最新存活版本的 seq。
     *  未参与版本链去重的被剪节点无此字段（undefined）。 */
    latestOfPath?: number;
}
export declare class ArgpGraphEngine extends CompactionEngine {
    static inject: string[];
    readonly windowTokens: number;
    readonly retainTokens: number;
    /** true = config 显式给 windowTokens；false = 运行时按 contextWindow × windowRatio 解析。 */
    private readonly explicitWindowTokens;
    /** true = config 显式给 retainTokens；false = 运行时按 windowTokens × retainRatio 解析。 */
    private readonly explicitRetainTokens;
    /** 最近一次 resolveScaledBudgets 解析出的有效预算（recall 预算等后续同步使用点读取）。 */
    private resolvedWindowTokens;
    readonly reserveTokens: number;
    readonly tokenMeterFn?: (session: Session) => {
        contextTokens: number;
        surfaceTokens: number;
    };
    readonly degradationStrategy: 'lifecycle' | 'summarize' | 'force' | 'fail';
    readonly turnBasis: 'semantic' | 'all';
    /**
     * UI 设置页可调旋钮的实时解析值（Settings → Plugins → Configurable → ARGP）。
     * 构造期为 cordis 配置基线；ctx.inject(['settings']) 注册后随用户写入实时更新。
     */
    private argpSettings;
    /** settings 源 thunk：ctx.inject(['settings']) 注册后置为 scope.get()，否则回退 cordis 基线。 */
    private settingsSource;
    get windowRatio(): number;
    get retainRatio(): number;
    /**
     * 守卫读取点统一走 getter：反应式补救（L2）在第 2 次尝试时用 `guardOverride` 临时
     * 放宽守卫（连当前轮一起剪），使"被钳后回线"成为可能；其余时刻恒等于 settings 值。
     */
    private guardOverride;
    get recencyGuard(): number;
    get turnGuard(): number;
    get minSpanChars(): number;
    get charsPerToken(): number;
    get maxPasses(): number;
    get enableSummarize(): boolean;
    get sortMode(): 'legacy' | 'density' | 'density-chain';
    readonly maxOverflowRetries: number;
    /** P4 溢出三步第②步回调（undefined = 退化为现役两步）。 */
    readonly onOverflowCompress?: (session: Session) => Promise<void>;
    /** P6 轮内压力压缩回调（undefined = 仅溢出才压 open turn，P6 前行为）。 */
    readonly onPrePressureCompress?: (session: Session) => Promise<void>;
    /** 闭包静止窗 K（A11 参数化，默认 2）。 */
    readonly closureWindowK: number;
    /** cites 前缀最小长度守卫（A2，默认 2；ASCII ≥4 / CJK ≥2 的换算由守卫实现）。 */
    readonly citeMinPrefixLen: number;
    /** 版本链重叠归链阈值 θ（A4，默认 0.8）。 */
    readonly overlapTheta: number;
    /** 版本链重叠归链开关（A4，默认 false）。 */
    readonly enableOverlapChain: boolean;
    /** dsh token-meter 服务；真会话中可用时优先用于 token 测量和 contextWindow 探测。 */
    private readonly tokenMeter;
    readonly records: GraphPruneRecord[];
    readonly recallCalls: {
        seq: number;
        hit: boolean;
        state?: NodeStateLabel;
    }[];
    readonly recallQueryCalls: {
        query: string;
        count: number;
        hits: number;
    }[];
    readonly citeStats: CiteStats;
    /** §3-3 recall 价值继承：最近一次 recall 的旧原子 seq 与结果 R 原子 seq（建图时用）。 */
    private recallSourceSeq;
    private recallResultSeq;
    /** 最近一次建图的语义边（判决 G3 读：被引原子是否获得保护）。 */
    lastEdges: SemanticEdge[];
    /** 最近一次建图的确定性边（组内 A→R，不参与语义级别排序）。 */
    lastDeterministicEdges: DeterministicEdge[];
    /** 边价值实验 A₃：注入的 oracle 边（buildGraph 合并用）。 */
    injectEdges: ((atoms: Atom[]) => SemanticEdge[]) | undefined;
    /** 边价值实验 A₁ 离线重放：跳过 cites 边构建（同时隔离推断边，见 config 注释）。 */
    disableCiteEdges: boolean;
    /** 推断边开关（PROPOSAL-token-ontology 组件 A，v1.2.0；默认启用）。 */
    disableInferredEdges: boolean;
    /** tombstone 归并阈值（§11.8① 修复；默认 8，0=关闭；见 ArgpGraphConfig.tombstoneMergeMinRun）。 */
    tombstoneMergeMinRun: number;
    /** 推断边派生参数（config 缺省 6/0.15/8/20；见 InferredEdgeOptions）。 */
    inferredOpts: InferredEdgeOptions;
    /** 推断边统计（最近一次 buildGraph 口径）。 */
    readonly inferredStats: InferredStats;
    /** 最近一次建图的推断边（诊断/测试断言用；同 lastEdges）。 */
    lastInferredEdges: SemanticEdge[];
    /** 回复级 cites 义务实际生效值（auto 已解析；构造期定死，运行期不重评）。 */
    readonly citesObligation: boolean;
    /** citesObligation 是否 auto 口径（config 未显式给值）。auto 下 section 恒注册、
     *  text 回调随 declarer.armed 动态返回 ''（autoLlm 会话中期武装的时序修复，2026-09-21）。 */
    readonly citesObligationAuto: boolean;
    /** P0 双引擎自挂载句柄（config.peratom 缺省时为 null；观测/诊断用）。 */
    readonly peratomStack: {
        compressor: PeratomCompressor | null;
        declarer: CiteDeclarer | null;
        zoom: RecallZoom | null;
    } | null;
    /** 已剪节点目录（seq -> 元数据 + 依赖），供 list_pruned 查询；新事务覆盖旧 seq。 */
    readonly prunedNodeIndex: Map<number, PrunedNodeInfo>;
    /** 闭包生命周期剪除记录。 */
    readonly closurePrunes: {
        closureId: string;
        rootSeq: number;
        prunedSeqs: number[];
        at: string;
    }[];
    private nextClosureId;
    /** 闭包最近一次被 recall 回拉的轮次；key = rootSeq（跨 pass 稳定，见 P2 修复注释）。 */
    private closureLastRecalled;
    private recallCallsThisTurn;
    private recallCharsUsed;
    /**
     * 冻结的 catalog 文本快照：system 块是单条被前缀缓存的消息，块内任何字节变化都会
     * 让整块 KV 失效。故 catalog 不与每步 assemble 联动，而是"全程冻结、仅在真正落剪时刷新一次"
     * （见 bindSession 初值 + pruneIntervals 末尾刷新）。无剪枝的整段对话里 system 块逐字节一致，
     * 前缀缓存全段命中；剪枝本身已改动可见上下文，那一步的缓存失效是必然代价。
     */
    private frozenCatalog;
    /** context-overflow 恢复：每个 agent 的重试计数（assistant/message 成功或 idle 时重置）。 */
    private readonly overflowRetries;
    /** session → agent 映射，供成功后重置重试计数（agent loop 上下文经 session/event 取不到 agent）。 */
    private readonly overflowAgents;
    /** 最近一次请求的真实 prompt token（usage.inputTokens + cacheReadTokens + cacheWriteTokens，
     *  provider 回报，与 UI ContextMeter 分子同口径）。
     *  pressure check 用它锚定 + 增量估算，替代 tokenMeter 的 chars/4 启发式（低估 30%+，
     *  导致迟触发/窗口保护失效，2026-08-23）。 */
    private lastRealPromptTokens;
    /** 声明窗口缓存（session → 适配器声明的 contextWindow，来自 request/context 事件）。
     *  2026-08-28 真环境联调：物理窗口探测（llama.cpp n_ctx=262144）与声明窗口（32000）
     *  在 pre-step 时刻可能错位，声明值缺失时宁可跳过检查也不用物理口径。 */
    private readonly declaredContextWindows;
    /** 锚点：lastRealPromptTokens 已覆盖的 surface 最大 seq（其后新增内容需增量估算）。 */
    private lastRealAnchorSeq;
    /** /compact 手动压缩的发起命令 ID（presentation correlation，透传给事务事件）。 */
    private compactSourceCommandId;
    /** A7：账目重建后追加的审计警告（供测试断言/诊断）。 */
    readonly auditWarnings: string[];
    /** A7：已重建过的 compactionId 集合（跨 session 重置，保证幂等 + 告警不重复）。 */
    private rebuiltCompactionIds;
    /** L2/L3 反应式：观察到"输出被外部钳制"后置位，由 pre-step（turn 仍在跑）或 turn-stopping（本轮要收）消费。 */
    private readonly reactivePending;
    /** 本次请求声明的输出预算（`agent/request` 捕获；适配器的钳制发生在其后，故这里拿到的是请求值）。 */
    private readonly requestMaxTokens;
    /** 三级触发 ①②③ 开关与旋钮（cordis 配置，不进 UI 设置页）。 */
    private readonly midTurnPruneEnabled;
    private readonly midTurnTurnGuard;
    /** 兼容别名路径：`midTurnActive: true` ⇒ 轮中用默认 `turnGuard`（1.3.x 语义）。 */
    private readonly midTurnLegacyGuard;
    private readonly reactiveRetries;
    private readonly continuationNotice;
    /** 本 episode（连续被钳）内已用掉的"剪枝 + 续写"次数；出现一次正常输出即清零。 */
    private readonly reactiveRescues;
    private session;
    private shadowedSession;
    private shadowedSet;
    private shadowedScanned;
    /** 结构化日志门面（构造期自 ctx 捕获）。 */
    private readonly log;
    constructor(ctx: Context, config?: ArgpGraphConfig);
    /**
     * A7（问题 3 修订）：session 绑定统一入口——setSession / agent/pre-step / compactIfNeeded 首次绑定
     * 都走这里。绑定后若 records 为空且日志含 compaction/start 事件（resume 场景：账目丢失仅日志在），
     * 懒触发 rebuildLedgerFromLog() 自动重建；幂等由 rebuiltCompactionIds 去重保证。
     */
    private bindSession;
    setSession(session: Session): void;
    /**
     * 真实 token 锚点回填（2026-09-21 修，问题定位见 docs/audit-prune-priority / 当日台账）。
     *
     * 背景：`lastRealPromptTokens` / `lastRealAnchorSeq` 原先**只**由 `ctx.on('session/event')`
     * 的 `assistant/message` 处理器写入。宿主进程重启后 resume 的会话若不再把该事件喂给本
     * 引擎（真环境 2026-09-21 实证：同一会话 turn 1 锚点正常、turn 2 起恒为 0），
     * `measureTokens` 会静默走回退分支 `visibleChars / charsPerToken`——而 `visibleChars`
     * 的投影口径**不含 reasoning**。实测该估算 ≈ 真实 prompt 的 **0.48 倍**：
     *   turn 6 真实 prompt 210,719 tok 时估算仅 ≈102,703 ⇒ 触发线 100,007 一路不越线，
     *   直到真实 prompt 210,719 才触发（迟 2.1×，66 步空转；graph 剪全程只跑 1 次）。
     *   windowRatio=0.8 档下估算上限 ≈126K **永远够不到** 210,715 触发线 ⇒ 压力路径
     *   完全不触发，只剩 provider 报错后的溢出恢复兜底。
     *
     * 口径与 usage 处理器**完全一致**（in + cacheRead + cacheWrite = provider 回报的 billed
     * prompt），取日志中最后一条带 `usage.inputTokens` 的 `assistant/message`——即本进程
     * 重启前最后一次真实请求的 prompt 规模。日志无带 usage 的应答（全新会话）⇒ 重置为
     * 0 / -1，保持既有回退行为（新会话首轮本就没有可用锚点）。
     *
     * 幂等与成本：反向扫描在最后一条带 usage 的应答处提前返回（通常就是最后一条应答）；
     * 会话身份每步换新（见 bindSession 注释）时重复回填的值恒等于 live 处理器写入的值
     * （日志 append-only，最后一条 usage 恒 ≥ 内存锚点），故重复执行不会回退。
     */
    private restoreUsageAnchor;
    /** 生成上下文头部 catalog（设计稿 §5 + A9）：U/A/R 三类都列（R 带 type=R），snippet 截断，字符预算驱动（A9）。 */
    catalogText(maxItems?: number, snippetChars?: number, tokenBudget?: number): string;
    /** 按关键词查询被剪节点原文（设计稿 §6 的 recall(query) 简化版）。 */
    recallQuery(query: string, maxResults?: number): string;
    /**
     * 增量维护被遮蔽 surface seq 集合：事件日志只追加，游标从上次扫描处继续，
     * 避免每次 recall/剪枝压力检查都 O(事件总量) 重扫。session 切换时重置。
     */
    private shadowedSeqsOf;
    /**
     * 程序化 recall（RecallHandle 语义）：**仅**命中被遮蔽节点，未命中返回 null。
     * 这是给宿主/测试用的窄接口，故意保留 pruned-only 语义（历史 spike 系列的
     * `engine.recall(seq) !== null` 探针依赖它判定"是否已被剪"，去门控会破坏探针）；
     * 模型侧 recall_pruned 工具已按 P1 修复 (b) 去门控并带状态标签，
     * 程序化的全日志入口是 recallAnyState()。
     */
    recall(seq: number): string | null;
    /**
     * 全日志级 recall（P1 修复 (b) 的程序化入口）：对任意界内 seq 返回原文 + 状态标签，
     * 不要求节点属于 pruned 集合。越界返回 null。
     */
    recallAnyState(seq: number): {
        text: string;
        state: NodeStateLabel;
    } | null;
    /** 单个 seq 相对可见上下文的状态（shadowed / live / off-surface）。 */
    nodeState(seq: number): NodeStateLabel | null;
    /**
     * 原子化（§4.1）：只投影 surface 节点；U/X/R/A 四类（tool/call 不进 surface，无 T 类）。cites 统计在 A 原子处累计。
     *
     * node 0 保护（2026-09-10，dsh 0.1.5 起）：宿主把 system prompt 表示为 surface node 0 的
     * `system/message`，并在 surface.ts `assertSystemHeadRewrite` 里硬性保护——任何覆盖 node 0 的
     * replace 必须是"恰好覆盖该单节点的 system/message"，否则 throw。
     * 本函数的 switch 只认 `user/message` / `assistant/message` / `tool/result`，其余类型（含
     * `system/message`）**静默跳过、不产出原子**，因此 node 0 永远不会进入 ARGP 的剪枝区间，
     * 上述宿主断言不会被触发。**这是有意依赖，不是巧合**——若日后要支持剪系统提示，
     * 必须同时改这里与宿主契约。守护用例见 test/argp-graph-engine.test.ts
     * 「system prompt at surface node 0 is never selected for pruning」。
     */
    atomize(session: Session): Atom[];
    /**
     * A2 前缀长度守卫（问题 5 修订）：统一按「有效字符」折算——ASCII 1 字符、CJK/全角 2 字符，
     * effective = ascii + wide×2 < minLen（默认 4）即视为噪音前缀（"的""a""the"）→ 不参与匹配。
     * 效果："the"(3 ascii) 拒、"读书"(2 wide = 4) 放行、"the quick"(9 ascii) 放行。
     */
    private citePrefixTooShort;
    /** A5 倒排索引：prefix n-gram → atom id 候选集（n=3）。索引查询只给候选，命中须过验证谓词。 */
    private readonly ngramN;
    private buildNGramIndex;
    /** 查询候选集：前缀长度 < n 时返回 null（走全扫描回退）。取前缀上 ≤3 个 n-gram 交集收窄候选。 */
    private queryNGramCandidates;
    /**
     * 建图（§4.2 + §4.7 + A1/A2/A5）：确定性边不计级别；cites 子串匹配生成语义边，
     * 级别取声明级别（V6 契约，裸字符串默认 supporting；critical 参与闭包守卫不变量 2′）。
     * A5：3-gram 倒排索引候选（先精确 n-gram 命中，再子串验证）；前缀过短自动全扫描回退。
     * 歧义消解增强（A2）：命中集内 U 优先 → 最长公共前缀最深的原子优先 → 最早 seq。
     * 前缀长度守卫：过短前缀不计 declared 也不建边。
     */
    buildGraph(atoms: Atom[]): {
        edges: SemanticEdge[];
        deterministicEdges: DeterministicEdge[];
        inDegree: Map<number, number>;
    };
    /** surface 可见字符总量（与 spike 4 同基准）。 */
    private visibleChars;
    /** 测量当前上下文 token。优先「真实 usage 锚点 + 增量估算」（2026-08-23，
     *  替代 tokenMeter chars/4 低估导致的迟触发/窗口保护失效）；无锚点才回退
     *  dsh tokenMeter / 配置函数 / 字符估算。source 标注估计来源（2026-08-29：
     *  压力日志与实验审计需要区分 anchored 真值路径与启发式回退路径）。
     *  `extraTokens`（1.4.0）：本步**已 claim 但尚未落盘**的 user 消息估值。轮初它既不在
     *  surface 里、也不在锚点覆盖范围内，漏掉就等于漏算"这一轮的启动量"——而用户恰恰
     *  常在轮初粘贴大段文本，正是 1.3.x 轮初估值偏低的直接原因。 */
    private measureTokens;
    /**
     * 本步已 claiming（尚未落盘进 surface）的 user 消息估值：字符数 ÷ charsPerToken。
     * 与 `measureTokens` 的增量口径同基准（同一 charsPerToken），可直接相加。
     */
    private incomingTokens;
    /** A4 行级重叠相似度：sim=|A∩B|/min(|A|,|B|)（行集合）。 */
    private static lineOverlap;
    /**
     * §4.4 版本链去重（+ A3 N1 bug fix + A4 θ 重叠归链）：
     *  - A：文本全等（不变）。
     *  - R：按「issuer A 的 tool name + arguments JSON」去重（而非旧版 issuer?.text.trim()），
     *    解决「同措辞不同工具调用（如不同参数 read different files）被错误归链去重」的问题。
     *    回退：issuer 不存在时用 r.text（callId 缺失的最小退化）。
     *  - A4：enableOverlapChain 时，R 文本行重叠 sim ≥ θ（默认 0.8）也归入同一版本链
     *    （read→edit→read 等高频工具迭代）；A 文本仍走全等。
     * 返回 { dupIds, chainLen }：chainLen 记录每个存活代表（newer）的链长，供 density-chain 叠加 eff。
     */
    private findVersionDuplicates;
    /**
     * 当前最大 turn 号（recall 回拉防抖窗口 / 闭包保护窗口共用口径）。
     *
     * P4 修复：旧实现遍历 **全部 events** 取 max，把 turn/start、注入型 system-reminder
     * 等非 surface 事件也算进来，与 compactIfNeeded / tryPruneClosures 用的
     * "atoms（surface 节点）最大 turn" 口径不一致 —— 同一个防抖判定两端基准不同。
     * 现统一为 surface 节点口径；turnBasis='semantic'（默认）时进一步排除注入型 X 节点，
     * 使纯注入不推进轮次、不抬高 latestTurn-k 保护线。
     */
    latestTurnOf(session: Session): number;
    private latestTurnOfSession;
    /**
     * recall 命中被剪闭包内节点时，将该闭包拉回 ACTIVE 并记下防抖轮。
     *
     * P2 修复：防抖 key 从 closureId 改为 rootSeq。closureId 由 `nextClosureId++` 生成，
     * tryPruneClosures 每 pass 都给所有 root 重发新 id，导致此处写入的旧 id 与
     * 剪枝决策处读取的新 id 永不相等 → `continue` 防抖分支永不触发 → 刚 recall 回来的
     * 闭包下一 pass 又被剪。rootSeq 跨 pass 稳定，是闭包的天然身份。
     */
    private noteRecallHit;
    /**
     * recall 预算：单次结果与累计结果都按窗口比例截断（窗口取最近解析的有效预算）。
     *
     * P7 修复：recallCharsUsed 原本只增不减、全会话无 reset —— 累计触顶后 allowed=0，
     * 返回值退化成纯 '…(truncated)' 且不说明原因，长会话静默丢 recall。现在
     *  1) 预算耗尽时显式说明剩余额度与何时恢复（不再静默）；
     *  2) 每笔 compaction 事务成功后归零（见 pruneIntervals 末尾）。
     */
    private budgetRecallText;
    /**
     * A6（保守选项 a）：summarize 末环不实现 —— 保持默认关闭（enableSummarize=false）、
     * force_prune 为终端降级，文档明确。本 stub 恒返回 null，degradationStrategy='summarize'
     * 且 enableSummarize=true 时也不会产出 LLM 摘要；实际路径仍为 lifecycle → force。
     */
    private summarizeCriticalChain;
    /** P2 选择侧（2026-08-22 拆出）：选一个 PRUNABLE 闭包并返回其原子/区间，不执行剪枝。
     *  `alreadyPruned` 用于排除已由正常候选/版本重复剪过的原子——修复前 tryPruneClosures
     *  按整闭包（含已剪原子）独立剪枝并 return，导致正常候选成果被丢弃；现改为"选择并入
     *  pruned、统一事务剪"，闭包原子需与已剪集合去重（如 A1/A2 已正常剪 → 闭包仅剩 root U，
     *  单独退休 root U 是有意设计：P5 注释"自动闭包生命周期确实会连 root U 一起剪除"）。 */
    private selectClosureToMerge;
    /** P2：尝试按闭包生命周期剪除一个 PRUNABLE 闭包。返回 CompactionResult 或 null。 */
    tryPruneClosures(session: Session, atoms: Atom[], edges: SemanticEdge[], inDegree: Map<number, number>, askCover: Map<number, number>, latestTurn: number): CompactionResult | null;
    /**
     * 预算解析：显式配置用显式值；否则从适配器声明的 contextWindow 按比例推导——
     *  windowTokens = contextWindow × windowRatio（默认 0.8），retainTokens = windowTokens × retainRatio（默认 0.2）。
     *  上下文容量由其他插件（模型适配器声明）决定，本引擎不硬编码。
     *  解析顺序：1) session.requestContext()（request/context 事件，真会话最可靠）；
     *           2) llm.resolveModelInfo(provider, model)；3) 静态默认值。
     */
    private resolveScaledBudgets;
    /**
     * tombstone 归并（v1.2.x §11.8① 修复）。扫描 surface，找**连续**的「可合并墓碑」X 段
     * （user/message + isMergeableTombstone 文本），段长 ≥ tombstoneMergeMinRun 时一笔事务
     * replace 成单条聚合墓碑（列出原 tombstone seqs → 原文仍 recall_pruned(seq) 可取回）。
     * 复用 pruneIntervals 事务骨架（含 shadow-price 契约、summary、锚点重置）。
     * 每 pass 至多一段——失败回退范围清晰。返回被归并的墓碑节点数（0 = 无可归并）。
     * tool 占位墓碑（type=tool）与 system-reminder / 官方 checkpoint（不含 pruned by ARGP）
     * 均被 isMergeableTombstone / 事件类型过滤挡住，不会被吞。
     */
    private consolidateTombstones;
    /**
     * 压力剪枝（§4.3/§4.5）：估算量 ≥ windowTokens 时重建图，按排序键逐弱剪至 ≤ retainTokens。
     * 候选：A/T/R、语义入度 0、非近因豁免区、非最新轮、非保守保护；普通 U 仅 ask-exempt 参剪，
     * X（墓碑/checkpoint）不参剪——但墓碑地板由 §11.8① tombstone-merge 在图剪前归并（见 consolidateTombstones）。
     * 排序键（§4.5）：最低关联语义级别升 → effective_importance 升 → lastRefRound 升 → seq 升。
     * 候选耗尽仍超预算 → force_prune（忽略入度，§4.6.2）。
     *
     * trigger='context-overflow'（官方溢出恢复，见 agent/request-error 钩子）：
     * 模型请求已被 provider 确认超出上下文（400 exceed_context_size_error）——估算量
     * 可能与实际请求偏差（估算低于触发线但请求已撞墙），此时**跳过 pressure 门槛强制
     * 剪枝**，剪到 retain 目标（≈1/5 窗口，远低于 n_ctx）后由钩子重发请求。
     */
    /**
     * P6 轮内压力判定（与 compactIfNeeded('pressure') 同口径，2026-09-19 方案 B）：
     * 声明窗口已知 且 contextTokens ≥ windowTokens − reserveTokens。抽出供 pre-step
     * 钩子复用，避免两处重复预算解析（口径漂移风险）。返回 false = 未达标（或
     * reserve 超窗 / 声明窗口未知）⇒ 调用方跳过轮内压缩。
     */
    private isPressureExceeded;
    /**
     * L2 反应式补救（三级触发②）：轮中唯一允许的压缩时机。
     *
     * 触发源见 `session/event` 里的 max-tokens 判据（输出被宿主/适配器钳制 = 容量压力已由
     * 上游确认）。执行用 `context-overflow` trigger 走 `compactIfNeeded` —— 该 trigger
     * **绕过阈值早检**（"仍未回线"的真信号由上游继续钳输出给出），即"强制剪一次"。
     *
     * 升级策略：第 2 次起临时放宽 recencyGuard/turnGuard（连当前轮一起进入候选）——因为
     * 常规轮内剪枝受 turnGuard 保护几乎剪不动，"被钳后回线"需要更狠的手段。用尽
     * `reactiveRetries` 次即停止重试并交给 overflow 路径（provider 400）兜底：避免
     * "每步都被钳 → 每步白压"的死循环（那比现状更糟，每圈多吃一次输出）。
     */
    /**
     * 反应式"零候选"重挂：把钳制信号留给下一次机会（下个 pre-step / 下一轮 turn-stopping），
     * 那时阶梯已 +1 ⇒ 守卫放宽，原本剪不动的局面（turnGuard 保护当前轮）才可能剪动。
     * 额度用尽则不再重挂（避免"每步白压"）。
     */
    private rearmReactive;
    /**
     * L2：turn 仍在跑时的反应式收紧剪。被钳后宿主可能继续本 turn（还有 next-step 输入），
     * 此时就在下一个 pre-step 剪；若本轮要收，则由 turn-stopping 的 L3 路径剪 + 续写。
     * 两者共用同一个 episode 计数器（`reactiveRescues`），故连续被钳会逐级放宽守卫而不是各自从头开始。
     */
    private runReactivePrune;
    compactIfNeeded(agent: CompactionAgentContext, trigger: CompactionTrigger, _signal: AbortSignal, 
    /** 本步已 claim 未落盘的 user 消息估值（轮初专用；其余调用点省略）。 */
    incomingTokens?: number): Promise<CompactionResult | null>;
    compactNow(agent: ManualCompactAgentContext, signal: AbortSignal, sourceCommandId?: CommandId): Promise<CompactionResult | null>;
    compactRegion(start: number, end: number, agent: CompactionAgentContext, signal?: AbortSignal): Promise<CompactionResult>;
    /** 为手动 compactNow 选择**全部**可剪的极大连续 A/R 段（确定性、由旧到新）。
     *
     *  入选判据（与旧版一致，仅去掉"遇阻即停"）：段内原子必须
     *  ① 是对话载体 A/R（U/X 不参剪，手动入口不剪骨架，见 compactRegion 的 P5 约束）；
     *  ② 不落在 turnGuard（最近 N 轮）与 recencyGuard（surface 末尾 N 节点）保护窗口内。
     *
     *  修复（2026-09-21）：旧实现扫到第一个不合格节点就 `break`，而真实会话的 surface 被
     *  用户消息切成「U A R A R U A R …」多段结构 ⇒ 手动 /compact 永远只剪最老一小段
     *  （表现为"图剪压不动"）。现在改为收集全部极大连续段，交给一笔 pruneIntervals 事务剪除。
     */
    private selectManualRanges;
    /** 手动多区间压缩：逐段复核边界后合并为一笔事务剪除。
     *  边界复核与 compactRegion 同口径（配对平衡 / 段内不含 U/X / 段内有可剪原子），
     *  任一区间不合格则**静默剔除该区间**（而非整体失败）——手动入口的语义是"能剪多少剪多少"。
     *  返回 null = 全部区间都被剔除（无可剪内容），调用方据此显示 "No compactable history yet."。 */
    private compactRegions;
    /** 一笔事务剪多个极大连续区间：start → summary → 每区间 checkpoint replace → end。
     *  tombstone 类型（2026-08-23 半拆组）：'user' = 普通/闭包墓碑文本；'tool' = tool/result
     *  占位墓碑（克隆原 R data、只改 tool-result block 的 inner text，保留 callId/isError/role/id
     *  ——dsh assertToolResultRewrite 只允许改 inner text），配对 issuer A 的 tool_calls 防 400。 */
    private pruneIntervals;
    /**
     * A7 事务账目重建：resume 时从 append-only 日志扫描 compaction/start、compaction/prune、
     * compaction/end 事件重建 records/prunedNodeIndex/shadowedSeqsOf 状态；无 end 的 start 记 warn。
     * 不引入 WAL——日志本身即账目。幂等：已重建过的 compactionId 跳过（rebuiltCompactionIds 去重），
     * 使「setSession 自动重建」与「测试显式清空 records 后再重建」两种路径都安全。
     */
    rebuildLedgerFromLog(): void;
    /** 日志尾部的 open turn（pre-step 时刻用于 compaction 括号的 owner）。 */
    private detectOpenTurn;
}
export default ArgpGraphEngine;
