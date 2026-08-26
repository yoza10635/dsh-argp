export { ArgpGraphEngine, default } from './argp-graph-engine.js';
export * from './argp-graph-engine.js';
// Per-Atom Stage-1（双引擎方案）：门控模块 + eager 熵降管线
export * from './peratom/gate.js';
export { PeratomCompressor, default as PeratomCompressorDefault } from './peratom/compressor.js';
// CiteDeclarer 边声明管线（P2）：idle 触发 LLM 声明引用边，喂 Stage-2 injectEdges
export { CiteDeclarer, CITATION_WINDOW_TURNS, citeDeclarerDefaultEndpoint, collectDeclAtoms, normalizeCites, } from './peratom/cite-declarer.js';
