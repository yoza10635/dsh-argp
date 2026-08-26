export { ArgpGraphEngine, default } from './argp-graph-engine.js'
export * from './argp-graph-engine.js'

// Per-Atom Stage-1（双引擎方案）：门控模块 + eager 熵降管线
export * from './peratom/gate.js'
export { PeratomCompressor, default as PeratomCompressorDefault } from './peratom/compressor.js'
export type {
  CompressDecision,
  CompressRecord,
  CurrentTurnCollect,
  PeratomCompressorConfig,
  ToolAction,
  UserSplit,
} from './peratom/compressor.js'
// CiteDeclarer 边声明管线（P2）：idle 触发 LLM 声明引用边，喂 Stage-2 injectEdges
export {
  CiteDeclarer,
  CITATION_WINDOW_TURNS,
  citeDeclarerDefaultEndpoint,
  collectDeclAtoms,
  normalizeCites,
} from './peratom/cite-declarer.js'
export type {
  CiteDeclarerConfig,
  CiteRecord,
  DeclAtom,
  DeclCollect,
  DeclaredCite,
  DeclaredLevel,
} from './peratom/cite-declarer.js'
// RecallZoom 两级召回 zoom（P3）：gist 档 recall_summary + exact 档 recall_detail（verbatim 天花板），4 倍制预算
export {
  RecallZoom,
  DEFAULT_BUDGET_RATIO,
  resolveSummaryText,
  default as RecallZoomDefault,
} from './peratom/recall-zoom.js'
export type {
  RecallZoomConfig,
  RecallZoomRecord,
  SummaryResolution,
  SummarySource,
} from './peratom/recall-zoom.js'
// 双引擎生产挂载工厂（P4）：三管线 + Stage-2 图引擎组装为声明式可挂载整体；P5 三臂开关
export { mountPeratomStack } from './peratom/mount.js'
export type { PeratomStack, PeratomStackConfig } from './peratom/mount.js'
