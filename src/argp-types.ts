/**
 * ARGP 通用类型叶子模块。
 *
 * 本模块是**叶子**：只含类型定义 + 纯常量，不 import 任何 src 运行时模块，
 * 运行时零依赖、类型图无环。
 *
 * 留在 hub 的类型：`ArgpConfig`（构造配置面），按「深度依赖则留 hub」原则保留在
 * 引擎侧（它引用引擎的旋钮面，迁入本叶子会形成类型环）。
 */

export type AtomType = 'U' | 'A' | 'R' | 'X' // X = compact tombstone/checkpoint/developer-message（V4 保留类型：tool-addition/tool-removal）；dsh surface 无 tool/call 节点（call 块内嵌在 A 里，SURFACE_EVENT_TYPES 实测）

export interface Atom {
  id: number            // 本次投影内局部递增
  seq: number           // 事件 seq（surface 节点）
  type: AtomType
  turn: number
  text: string          // 模型可见文本
  toolCallIds: string[] // A：发出的 tool-call id；R：应答的 call id —— 配对键（成对同剪防孤儿）
  /**
   * 仅 U-info 聚合副本有值——原始用户消息的日志 seq。历史 U-info 副本的恢复目标；
   * `sourceSeq !== undefined` 即 U-info 识别判据（dialog 副本与普通 user 消息无此字段）。
   */
  sourceSeq?: number
}

/**
 * UI 设置页名册（2.0.1 起**单旋钮**）：唯一活键 `compactionThreshold`（压缩阈值）
 * ——出口闸的触发比例；0/缺省=关闭（模型撞墙后自动压缩兜底）。其余五枚旧旋钮
 * （windowRatio/retainRatio/charsPerToken/focalTurns/vocabTopN/recallLimit）保持
 * 退役，缺省值固化在 constants.ts。本类型与 `ArgpUserSettingsSchema` 保持同键集。
 *
 * 老 profile 的同名键宽容读+告警忽略，见 normalizeConfig（RETIRED_KNOB_KEYS）。
 */
export interface ArgpUserSettings {
  /** 出口闸触发线 = 声明窗 × 本比例；0=关闭（撞墙 400 兜底）。 */
  compactionThreshold: number
}
