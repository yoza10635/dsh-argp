/** 生效时机：boot = 构造期快照（改 env 须重挂引擎）；live = 每个请求/调用现读。 */
export type WorldTiming = 'boot' | 'live';
export interface WorldFact {
    name: string;
    value: string;
    timing: WorldTiming;
}
export interface WorldFingerprint {
    /** 派生后的实际取值（不是原始 env 字面）。 */
    facts: WorldFact[];
    /** 显式设置过的 ARGP_FACTOR_* / ARGP_PERATOM_*（原样回显，便于对照启动脚本）。 */
    overrides: Array<{
        key: string;
        value: string;
    }>;
}
/**
 * @param env - 环境变量源（测试注入；生产 = process.env）。
 * @param compactionThreshold - 设置页「压缩阈值」当前值（出口闸线的另一输入；
 *   >0 时压过 env 的缺省档，见 resolveEgress）。
 */
export declare function describeWorld(env?: NodeJS.ProcessEnv, compactionThreshold?: number): WorldFingerprint;
