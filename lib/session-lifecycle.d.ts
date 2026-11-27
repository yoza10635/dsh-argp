/**
 * 会话生命周期 + 构造期装配（2.0 factor-only）：
 *  - 构造期：normalizeConfig（字段归一并拒坏形状）/ registerSettings（声明设置页 auto 表单）。
 *  - 运行时：bindSession（统一绑定 + 账目懒重建）/ rebuildLedgerFromLog（A7 事务账目重建）。
 *
 * 函数经窄接口 LifecycleHost 触达引擎（`this as unknown as LifecycleHost`，编译期类型、
 * 运行时同一实例；方法引用经 host 派发回 class 薄编排方法，this 绑定语义不变）。
 * 构造期副作用顺序由 hub 构造器调用次序保证：normalizeConfig → registerSettings →
 * FactorEngine/ProseCondenser → registerRecallLabels → systemPrompt sections → ctx.on。
 *
 * 设置页常量（ARG_SETTINGS_KEY / ArgpUserSettingsSchema / NAMESPACE_PATTERN / ARG_SETTINGS_NS）
 * 在本模块：ArgpUserSettingsSchema 是运行时值（z.object 产物），若放在 hub 会迫使本模块
 * 运行时 import hub 形成环；hub 反向 import 本模块并 re-export，公共 API 不变
 * （index.ts 的 `export *` 透出）。
 *
 * ArgpConfig 经 type-only import 取用（编译期擦除，无运行时环）。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Session } from '@deepseek-ai/dsh-session';
import z from '@deepseek-ai/schemastery';
import type { ArgpUserSettings } from './argp-types.js';
import { type PrunedNodeInfo, type SessionRuntimeState } from './session-state.js';
import { type TokenMeter } from './budget.js';
import type { GraphPruneRecord } from './prune-tx.js';
import type { ArgpConfig } from './argp-engine.js';
/** 设置页 namespace key（同时是 Host 服务端与客户端卡片的 key，须一致才进渲染交集）。 */
export declare const ARG_SETTINGS_KEY = "dsh-argp";
/**
 * 引擎设置 schema（schemastery）：**2.0.0 起零旋钮**——原六枚设置项
 * （windowRatio/retainRatio/charsPerToken + focalTurns/vocabTopN/recallLimit）
 * 全部退役，缺省值固化在 constants.ts；2.0.1 起名册唯一活键 = `compactionThreshold`
 * （压缩阈值：出口闸触发线 = 声明窗 × 比例；0=关闭，撞墙 400 兜底）。
 *
 * 真实校验面是 `ArgpEngine.Config`（宿主 0.1.7+ 扫描 static Config 生成
 * volatile form；settings.register 已随 #4587 移除，本 schema 经 hub re-export
 * 维持公共 API 与文档口径）。两面键集必须一致。
 *
 * 1.x graph 臂旋钮与 2.0 五枚退役旋钮在 cordis 非 strict 解析下一律宽容透传
 * （宿主实测未声明键原样透传）；normalizeConfig 对非缺省旧值告警忽略。
 */
export declare const ArgpUserSettingsSchema: z<ArgpUserSettings>;
/**
 * 窄宿主接口：本模块函数实际触达的引擎成员（字段 + 方法引用）。
 * 方法引用（shadowedSeqsOf/rebuildLedgerFromLog/restoreUsageAnchor/bindSession）
 * 经 host 派发到 class 上的薄编排方法，运行时 this 仍是引擎实例。
 */
export interface LifecycleHost {
    windowTokens: number;
    retainTokens: number;
    explicitWindowTokens: boolean;
    explicitRetainTokens: boolean;
    reserveTokens: number;
    telemetryCap: number;
    tokenMeterFn?: (session: Session) => {
        contextTokens: number;
        surfaceTokens: number;
    };
    tokenMeter: TokenMeter | undefined;
    maxOverflowRetries: number;
    log: {
        info: (msg: string) => void;
        warn: (msg: string) => void;
        error: (msg: string) => void;
    };
    session: Session | null;
    stateOf: (session: Session) => SessionRuntimeState;
    rebuiltCompactionIds: Set<string>;
    auditWarnings: string[];
    records: GraphPruneRecord[];
    prunedNodeIndex: Map<number, PrunedNodeInfo>;
    bindRuntimeState: (session: Session) => void;
    shadowedSeqsOf: (session: Session) => Set<number>;
    rebuildLedgerFromLog: () => void;
    restoreUsageAnchor: (session: Session) => void;
    bindSession: (session: Session) => void;
}
/**
 * 构造期字段归一（纯字段赋值，无 ctx 副作用）：windowTokens/retainTokens 静态默认 +
 * 顶层旋钮缺省。字段赋值与任何 ctx 副作用无交互（settings 回调不读本批字段），故整体
 * 置于 registerSettings 之前。tokenMeter 获取（acquireTokenMeter(ctx)）是唯一的 ctx 读取，
 * 保持在 settings 注册之前。
 */
export declare function normalizeConfig(ctx: Context, host: LifecycleHost, config: ArgpConfig): void;
/**
 * 设置页可见性声明（dsh 0.1.7+）。
 *
 * 宿主 0.1.7（#4587，`profile-owned-live-configuration`）移除了
 * `settings.register(ns, schema, { base })`：Settings 改为扫描插件的 `static Config`
 * 生成表单，表单值写回 profile 的 `cordis.patch.yml`。因此本函数不再注册任何东西，
 * 只做一件事——声明本插件实例允许设置页自动生成表单（auto: true，因为没有自定义
 * settings 页面）。引擎的旋钮值由 `ArgpEngine.Config` 的 volatile 引用提供。
 *
 * ⚠️ 旧实现的构造期快照（`host.argpSettings` / `host.settingsSource`）已删除：
 * 那套"注册后把基线与 scope.get() 二选一"的回退逻辑是为被移除的 register API 服务的。
 */
export declare function registerSettings(ctx: Context, _host: LifecycleHost, _config: ArgpConfig): void;
export declare function bindSession(host: LifecycleHost, session: Session): void;
/**
 * A7 事务账目重建：resume 时从 append-only 日志扫描 compaction/start、compaction/prune、
 * compaction/end 事件重建 records/prunedNodeIndex/shadowedSeqsOf 状态；无 end 的 start 记 warn。
 * 不引入 WAL——日志本身即账目。幂等：已重建过的 compactionId 跳过（rebuiltCompactionIds 去重），
 * 使「setSession 自动重建」与「测试显式清空 records 后再重建」两种路径都安全。
 * §8-11 后活体事务已由 prune-tx 成功收尾入账 prunedNodeIndex；同进程重放撞进的 seq 由
 * notePrunedNode 的 seq 幂等吞掉，不双计。
 */
export declare function rebuildLedgerFromLog(host: LifecycleHost): void;
