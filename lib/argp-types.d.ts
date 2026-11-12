/**
 * ARGP 通用类型叶子模块。
 *
 * 本模块是**叶子**：只含类型定义 + 纯常量，不 import 任何 src 运行时模块。
 * 唯一依赖是 `cites-strip` 的 `ParsedCite`（type-only import，编译期擦除；
 * cites-strip 本身是零依赖叶子），故运行时零依赖、类型图无环。
 *
 * 留在 hub 的类型：`ArgpGraphConfig`——它引用 peratom 三个管线 config
 * （PeratomCompressorConfig / CiteDeclarerConfig / RecallZoomConfig），若迁入本叶子会迫使
 * argp-types 反向 import peratom，形成类型环并破坏叶子性，故按「深度依赖则留 hub」原则保留在引擎侧。
 */
import type { ParsedCite } from './cites-strip.js';
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
export declare const LEVEL_ORDER: Record<string, number>;
/**
 * UI 设置页旋钮名册（design-2.0 §3.4，2.0 起 **7 枚**）：Settings → Plugins →
 * ARGP 卡片读写的面。真实校验/表单源是 `ArgpGraphEngine.Config`（宿主 0.1.7+ 扫
 * static Config 的 volatile 字段；settings.register 已随 #4587 移除），本类型与
 * `ArgpUserSettingsSchema` 保持同键集（公共 API 与文档口径）。
 *
 * 旧五键 maxPasses/recencyGuard/turnGuard/minSpanChars/sortMode 已退位（factor 臂
 * 不消费；graph 臂仍从 cordis config 读，宽容读+告警见 normalizeConfig）。
 */
export interface ArgpUserSettings {
    /** 触发线 = contextWindow × windowRatio（两臂共用）。 */
    windowRatio: number;
    /** 压缩保留目标 = 触发线 × retainRatio（两臂共用）。 */
    retainRatio: number;
    /** 字符/token 估算比（两臂共用；provider usage 锚点在位时以其为准）。 */
    charsPerToken: number;
    /** 2.0 判别式（§3.2）：会话内不可变（非 volatile，宿主拒 form 写）——卡不渲染，仅 profile 写值。 */
    engine: 'graph' | 'factor';
    /** factor 臂焦点轮数（§2.5）。 */
    focalTurns: number;
    /** factor 臂词表每类 topN（§1.4）。 */
    vocabTopN: number;
    /** factor 臂 recall_history 缺省 limit（§P0 宽度实测；现默认 5，上限 20）。 */
    recallLimit: number;
}
