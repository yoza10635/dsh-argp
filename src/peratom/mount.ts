/**
 * 双引擎生产挂载工厂（P4）：把三条 per-atom 管线与 Stage-2 图引擎组装为一个
 * 声明式可挂载的整体，作为 `ctx.compaction` 位的 compaction 插件入口。
 *
 * 装配拓扑（与 per-atom-implementation-plan.md §0 一致（已迁出公开仓库））：
 *   PeratomCompressor（普通 cordis 服务，idle 触发）────┐
 *   CiteDeclarer（普通 cordis 服务，idle 触发）──┐      │
 *   RecallZoom（普通 cordis 服务，注册工具）    │      │
 *   ArgpGraphEngine（ctx.compaction 位）◄───────┴──────┘
 *     ├─ injectEdges(atoms) = declarer.buildInjectEdges（P2 边声明管线 → Stage-2）
 *     └─ onOverflowCompress = compressor.compressCurrentTurn（P4 溢出三步第②步）
 *
 * 失败隔离免费获得：三管线各自吞异常，graph 引擎的接线闭包只是转发——
 * compressor 崩溃不影响 Stage-2 剪枝，declarer 崩溃不影响 compressor。
 *
 * P5 三臂开关（同一工厂，配置分叉）：
 *   A. peratom 全开：mountPeratomStack(ctx) —— 三条管线全挂
 *   B. 无边：mountPeratomStack(ctx, { declarer: false }) —— 剪枝/压缩在，cites 边缺席
 *   C. 现役基线：不读本工厂，直接 ctx.plugin(ArgpGraphEngine) —— 纯图引擎（溢出才剪）
 *
 * endpoint 缺失时的自然降级：compressor/declarer 构造器解析不到 endpoint 时
 * 自身进入 disabled 态（warn + 零网络），工厂无需特判；onOverflowCompress 接线
 * 保持——compressor.compressCurrentTurn 在 disabled 态静默返回（no-endpoint 记录），
 * 不阻断溢出三步的 ①③ 步。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { Atom } from '../argp-graph-engine.js'
import { ArgpGraphEngine, type ArgpGraphConfig } from '../argp-graph-engine.js'
import { PeratomCompressor, type PeratomCompressorConfig } from './compressor.js'
import { CiteDeclarer, type CiteDeclarerConfig } from './cite-declarer.js'
import { RecallZoom, type RecallZoomConfig } from './recall-zoom.js'

/**
 * 管线开关：`false` = 不挂载该管线；`true` / 对象 = 挂载（对象即管线 config，
 * 与管线构造器同构，endpoint 缺失自然降级）。缺省 = 全部挂载（true）。
 */
export interface PeratomStackConfig {
  /** graph 引擎 config（ArgpGraphConfig 透传；injectEdges/onOverflowCompress 由工厂接管，传入值被忽略）。 */
  graph?: Omit<ArgpGraphConfig, 'injectEdges' | 'onOverflowCompress'>
  compressor?: PeratomCompressorConfig | false
  declarer?: CiteDeclarerConfig | false
  zoom?: RecallZoomConfig | false
}

export interface PeratomStack {
  /** Stage-2 图引擎（ctx.compaction 位，含 recall_pruned / list_pruned 等既有工具）。 */
  engine: ArgpGraphEngine
  /** P1 eager 熵降管线（false 未挂载时为 null）。 */
  compressor: PeratomCompressor | null
  /** P2 边声明管线（false 未挂载时为 null）。 */
  declarer: CiteDeclarer | null
  /** P3 两级召回（false 未挂载时为 null）。 */
  zoom: RecallZoom | null
}

/**
 * 挂载双引擎全栈。幂等性由宿主保证（同一 ctx 不应重复挂载 compaction 位）。
 * 返回管线句柄（测试 / P5 三臂观测用；生产可不保留）。
 */
export async function mountPeratomStack(ctx: Context, config: PeratomStackConfig = {}): Promise<PeratomStack> {
  // 三管线在 graph 之前构造：hook 注册进 ctx 事件总线，graph 的接线闭包捕获句柄。
  // 顺序无竞争——compressor/declarer 的触发钩子（idle）与 zoom 的工具调用都发生在
  // agent loop 运行期，晚于本工厂的同步装配。
  const compressor = config.compressor === false ? null : new PeratomCompressor(ctx, config.compressor ?? {})
  const declarer = config.declarer === false ? null : new CiteDeclarer(ctx, config.declarer ?? {})
  const zoom = config.zoom === false ? null : new RecallZoom(ctx, config.zoom ?? {})

  const graphConfig: ArgpGraphConfig = { ...config.graph }
  // P2 接线：声明边经 injectEdges 通道进 buildGraph（seq→id 映射与离 surface
  // 丢弃在 declarer.buildInjectEdges 内完成，端点校验在 buildGraph 的 validIds 检查）。
  if (declarer !== null) {
    graphConfig.injectEdges = (atoms: Atom[]) => declarer.buildInjectEdges(atoms)
  }
  // P4 接线：溢出三步第②步 = 当前 open turn 的 per-atom 降熵（顺带补 cites）。
  // 溢出发生在 open turn 的请求上，必须压它——closed 口径会错压上一闭合轮
  // （2026-08-29 review 中项）。compressOpenTurn 失败隔离内建（endpoint 缺失/
  // 网络错误只记 record 不抛），钩子侧另有 try/catch 双保险。
  if (compressor !== null) {
    graphConfig.onOverflowCompress = async (session: Session): Promise<void> => {
      await compressor.compressOpenTurn(session)
    }
  }
  await ctx.plugin(ArgpGraphEngine, graphConfig)
  return { engine: ctx.compaction as ArgpGraphEngine, compressor, declarer, zoom }
}
