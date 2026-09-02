/**
 * ARGP spike 1 探针引擎：最小 CompactionEngine——compactIfNeeded 空转 + 日志。
 * 不做任何剪枝，只记录 harness 何时以何种触发调用引擎，验证挂载与生命周期。
 * 自动注册方式仿 compaction-basic（引擎自挂 agent/pre-step 压力钩子）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { CompactionEngine } from '@deepseek-ai/dsh-compaction'
import type {
  CompactionAgentContext,
  CompactionResult,
  CompactionTrigger,
  ManualCompactAgentContext,
} from '@deepseek-ai/dsh-compaction'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'

/** 一次引擎调用的观测记录。 */
export interface ProbeCall {
  at: string
  method: 'compactIfNeeded' | 'compactNow' | 'compactRegion'
  trigger?: CompactionTrigger
  surfaceNodes?: number
  eventCount?: number
}

/** 只观测、不剪枝的最小引擎。 */
export class ArgpProbeEngine extends CompactionEngine {
  /** 全部观测记录（spike 断言直接读这里）。 */
  readonly calls: ProbeCall[] = []

  constructor(ctx: Context) {
    super(ctx)
    // 仿 compaction-basic：引擎自挂步间压力钩子，动态分派 compactIfNeeded
    ctx.on('agent/pre-step', async ({ agent, signal }, next): Promise<PreStepDecision> => {
      if (!signal.aborted) {
        try {
          await this.compactIfNeeded(agent, 'pressure', signal)
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error)
          ctx.logger.warn(`argp-probe pressure failed: ${message}; continuing the turn`)
        }
      }
      return next()
    })
  }

  override async compactIfNeeded(
    agent: CompactionAgentContext,
    trigger: CompactionTrigger,
    _signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    const surfaceNodes = agent.session.surface.nodes.length
    const eventCount = agent.session.seq
    this.calls.push({ at: new Date().toISOString(), method: 'compactIfNeeded', trigger, surfaceNodes, eventCount })
    this.ctx.logger.info(
      `[argp-probe] compactIfNeeded trigger=${trigger} surfaceNodes=${surfaceNodes} events=${eventCount}`,
    )
    return null // spike 1：空转，永不剪枝
  }

  override async compactNow(
    agent: ManualCompactAgentContext,
    _signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    this.calls.push({
      at: new Date().toISOString(),
      method: 'compactNow',
      surfaceNodes: agent.session.surface.nodes.length,
      eventCount: agent.session.seq,
    })
    this.ctx.logger.info('[argp-probe] compactNow invoked (no-op in spike 1)')
    return null
  }

  override async compactRegion(
    _start: number,
    _end: number,
    _agent: CompactionAgentContext,
    _signal?: AbortSignal,
  ): Promise<CompactionResult> {
    throw new Error('argp-probe: compactRegion not implemented in spike 1')
  }
}

export default ArgpProbeEngine
