/**
 * 因子引擎共享类型（叶子模块，零依赖）。
 *
 * 设计依据：docs/design-2.0-factor-engine.md §1.3/§2.2/§2.3。
 * 全链路铁律：**除摘要外在线 0 LLM**——本目录下所有生产者都是纯函数或注入回调。
 */

/** facet 类别（查询键剔除 tool，见 §1.4；scope 不进召回键，仅辅助）。 */
export type Facet = 'document' | 'scope' | 'command' | 'errorcode' | 'tool'

/** fail-closed 注入面拒收原因（§1.3：拒收者留索引、不进 prompt）。 */
export type LabelReject = 'secret' | 'long' | 'newline' | 'empty'

/** 一个 R（tool result）的因子贴标结果。纯数据——文件快照等 fs 副作用由引擎侧附加。 */
export interface RTags {
  tool: string
  /** canonical document 键（行号引用已剥离；`rel:` 前缀 = 无事件时 cwd 的相对路径）。 */
  files: string[]
  /** 作用域键（grep 目录、cd 目标等）。 */
  scopes: string[]
  /** 命令族标签（`command:<family>`）。 */
  commands: string[]
  errorcodes: string[]
  /** 错误信号（exit≠0 / 错误词 / ALL_CAPS 码 / 注入的 isError）。 */
  errorish: boolean
  /** write 家族成功候选（sticky"修复宣称"原料；errorish 的 write 由调用方按语义排除）。 */
  writeish: boolean
  /** 本事件在场 cwd（bash cwd/dir 参数）。 */
  cwdSeen: boolean
  /** args 语义指纹（键排序/空白规整；失败-重试配对键，§1.3 canonical 纪律）。 */
  argsFp: string
  /** read 类 R 的读取范围（staleness 覆盖证明原料：旧读范围 ⊆ 新读范围）。 */
  readRange: { offset: number | null; limit: number | null } | null
  sizeChars: number
  rejects: Partial<Record<LabelReject, number>>
}

/** 贴标输入：args 原始态（string|object）由解析器统一；resultText 由引擎经 rawEventText 提供。 */
export interface ExtractInput {
  tool: string
  rawArgs: unknown
  resultText: string
  /** 事件时 cwd（session 头 / bash cwd 参数），无则 undefined——绝不拿当前 cwd 凑。 */
  sessionCwd?: string
  /** 宿主结构化错误标志（可得时注入；文本信号之外 OR 进来）。 */
  isError?: boolean
}

/** 文件版本快照（可再生性证明原料；fs 读取是引擎侧职责，本目录不碰）。 */
export interface FileSnapshot {
  mtimeMs: number
  size: number
}

/** 排序规约档位（§2.3 字典序；数值小者先剪）。 */
export interface PruneScore {
  /** 1 = 硬保护（绝不入剪枝区间）。 */
  hard: 0 | 1
  /** 可再生性证明（0=read 类且文件未变可验）。 */
  regenerable: 0 | 1
  /** staleness 覆盖证明（0=被后续全量读覆盖）。 */
  superseded: 0 | 1
  /**
   * 焦点带（0=非焦点先剪，升序=先剪；§2.5 v1.1 三值：0 none < 1 medium(命令面)
   * < 2 strong(文档面)）。flat 只发 0/1——三值仅 tiered 消费。
   */
  focal: 0 | 1 | 2
  /** 新鲜度（turn 距离，旧者先）。 */
  freshness: number
  /** 体积（大者先）。 */
  size: number
}

/** sticky 交集区状态机（§2.2；保护向，闭集从紧）。 */
export type StickyState = 'open' | 'sticky' | 'closed'
