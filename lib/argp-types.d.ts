/**
 * ARGP 通用类型叶子模块。
 *
 * 本模块是**叶子**：只含类型定义 + 纯常量，不 import 任何 src 运行时模块。
 * 唯一依赖是 `cites-strip` 的 `ParsedCite`（type-only import，编译期擦除；
 * cites-strip 本身是零依赖叶子），故运行时零依赖、类型图无环。
 *
 * 2.0 factor-only：图臂的边类型（SemanticEdge/DeterministicEdge/EdgeLevel/EDGE_WEIGHTS）
 * 随 stage-2 图剪退役；Atom 保留 cites 字段——读侧仍要解析历史 `data.argpCites`。
 *
 * 留在 hub 的类型：`ArgpGraphConfig`（构造配置面），按「深度依赖则留 hub」原则保留在
 * 引擎侧（它引用引擎的旋钮面，迁入本叶子会形成类型环）。
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
     * 仅 U-info 聚合副本有值——原始用户消息的日志 seq。历史 U-info 副本的恢复目标；
     * `sourceSeq !== undefined` 即 U-info 识别判据（dialog 副本与普通 user 消息无此字段）。
     */
    sourceSeq?: number;
}
/**
 * UI 设置页旋钮名册（design-2.0 §3.4，2.0 = **6 枚**）：Settings → Plugins →
 * ARGP 卡片读写的面。真实校验/表单源是 `ArgpGraphEngine.Config`（宿主 0.1.7+ 扫
 * static Config 的 volatile 字段；settings.register 已随 #4587 移除），本类型与
 * `ArgpUserSettingsSchema` 保持同键集（公共 API 与文档口径）。
 *
 * 1.x graph 五键（maxPasses/recencyGuard/turnGuard/minSpanChars/sortMode）与 engine
 * 判别式已退位：老 profile 宽容读+告警，见 normalizeConfig。
 */
export interface ArgpUserSettings {
    /** 触发线 = contextWindow × windowRatio。 */
    windowRatio: number;
    /** 压缩保留目标 = 触发线 × retainRatio。 */
    retainRatio: number;
    /** 字符/token 估算比（provider usage 锚点在位时以其为准）。 */
    charsPerToken: number;
    /** factor 焦点轮数（§2.5）。 */
    focalTurns: number;
    /** factor 词表每类 topN（§1.4）。 */
    vocabTopN: number;
    /** factor recall_history 缺省 limit（§P0 宽度实测；现默认 5，上限 20）。 */
    recallLimit: number;
}
