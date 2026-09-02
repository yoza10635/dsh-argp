import { CompactionEngine } from '@deepseek-ai/dsh-compaction';
/** 只观测、不剪枝的最小引擎。 */
export class ArgpProbeEngine extends CompactionEngine {
    /** 全部观测记录（spike 断言直接读这里）。 */
    calls = [];
    constructor(ctx) {
        super(ctx);
        // 仿 compaction-basic：引擎自挂步间压力钩子，动态分派 compactIfNeeded
        ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
            if (!signal.aborted) {
                try {
                    await this.compactIfNeeded(agent, 'pressure', signal);
                }
                catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    ctx.logger.warn(`argp-probe pressure failed: ${message}; continuing the turn`);
                }
            }
            return next();
        });
    }
    async compactIfNeeded(agent, trigger, _signal) {
        const surfaceNodes = agent.session.surface.nodes.length;
        const eventCount = agent.session.seq;
        this.calls.push({ at: new Date().toISOString(), method: 'compactIfNeeded', trigger, surfaceNodes, eventCount });
        this.ctx.logger.info(`[argp-probe] compactIfNeeded trigger=${trigger} surfaceNodes=${surfaceNodes} events=${eventCount}`);
        return null; // spike 1：空转，永不剪枝
    }
    async compactNow(agent, _signal) {
        this.calls.push({
            at: new Date().toISOString(),
            method: 'compactNow',
            surfaceNodes: agent.session.surface.nodes.length,
            eventCount: agent.session.seq,
        });
        this.ctx.logger.info('[argp-probe] compactNow invoked (no-op in spike 1)');
        return null;
    }
    async compactRegion(_start, _end, _agent, _signal) {
        throw new Error('argp-probe: compactRegion not implemented in spike 1');
    }
}
export default ArgpProbeEngine;
