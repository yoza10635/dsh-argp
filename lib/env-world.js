/**
 * 世界指纹（A2）：把 ARGP 的 env 逃生口收成**一份可读的实际生效值**。
 *
 * 病灶：生产行为不是 config 的纯函数，而是 `f(config, env)`——9 枚 `ARGP_FACTOR_*`
 * 加 2 枚 peratom 调试开关散在 factor/engine、factor/dispatch、llm-adapter 里，
 * 生效时机还不一致（`tiered`/`clip`/`qscore`/`pressure`/`shadow` 是**构造期快照**，
 * 改 env 须重挂引擎；`egress`/`dispatch`/peratom 调试是**每请求活读**）。
 * 排障时只看 profile 判断不出当前世界。
 *
 * 本模块**不新增 env、不改名**（老启动脚本/对照臂保持有效），只把既有 resolver
 * 的派生档聚合成 `/argp` 的一行指纹：`name=value@boot|live` + 显式 env 回显。
 * 派生档走 resolver 而非原始字面 ⇒ 显示的永远是引擎真正会用的值（非法值 =
 * 缺省档，而不是把 `ARGP_FACTOR_TIER=yes` 原样印出来骗人）。
 */
import { resolveClipEnabled, resolveEgress, resolveFocalTiered, resolvePressureTriggerEnabled, resolveQScoreEnabled, resolveShadowEnabled } from "./factor/engine.js";
import { resolveDispatchMode } from "./factor/dispatch.js";
/**
 * @param env - 环境变量源（测试注入；生产 = process.env）。
 * @param compactionThreshold - 设置页「压缩阈值」当前值（出口闸线的另一输入；
 *   >0 时压过 env 的缺省档，见 resolveEgress）。
 */
export function describeWorld(env = process.env, compactionThreshold = 0) {
    const egress = resolveEgress(env, compactionThreshold);
    const facts = [
        { name: 'dispatch', value: resolveDispatchMode(env), timing: 'live' },
        {
            name: 'egress',
            value: egress.enabled
                ? (egress.lineRatio === null ? 'on(old-line)' : 'on(' + egress.lineRatio + ')')
                : 'off',
            timing: 'live',
        },
        { name: 'tiered', value: resolveFocalTiered(env), timing: 'boot' },
        { name: 'clip', value: resolveClipEnabled(env) ? 'on' : 'off', timing: 'boot' },
        { name: 'qscore', value: resolveQScoreEnabled(env) ? 'on' : 'off', timing: 'boot' },
        { name: 'pressure', value: resolvePressureTriggerEnabled(env) ? 'on' : 'off', timing: 'boot' },
        { name: 'shadow', value: resolveShadowEnabled(env) ? 'on' : 'off', timing: 'boot' },
        { name: 'peratomDebug', value: isSet(env['ARGP_PERATOM_A2_DEBUG']) ? 'on' : 'off', timing: 'live' },
    ];
    const overrides = Object.keys(env)
        .filter(key => (key.startsWith('ARGP_FACTOR_') || key.startsWith('ARGP_PERATOM_'))
        && env[key] !== undefined && env[key] !== '')
        .sort()
        .map(key => ({ key, value: String(env[key]) }));
    return { facts, overrides };
}
function isSet(value) {
    return value !== undefined && value !== '' && value !== '0';
}
