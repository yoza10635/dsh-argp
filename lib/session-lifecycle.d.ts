/**
 * 会话生命周期 + 构造期装配（P5 Wave 3 第 4 步，C 报告 S1 + §4 蓝图 A：session-lifecycle 模块）。
 *
 * 从 hub `argp-graph-engine.ts` 迁出：
 *  - 构造期装配四函数中的三个：normalizeConfig（字段归一）/ registerSettings（UI 设置页注册）/
 *    mountPeratomStack（peratom 三管线自挂载 + maxOverflowRetries 提升 + citesObligation 解析）。
 *    （第四个 registerRecallTools 在 recall-tools.ts。）
 *  - 运行时方法：bindSession（统一绑定 + 账目懒重建）/ rebuildLedgerFromLog（A7 事务账目重建）/
 *    rearmReactive（反应式零候选重挂）/ compactNow（/compact 手动压缩入口）。
 *
 * 所有函数体逐字保留，仅 `this.x` → `host.x`（窄接口 LifecycleHost + `this as unknown as
 * LifecycleHost` 调用，编译期类型、运行时同一实例；方法引用经 host 派发回 class 薄编排方法，
 * this 绑定语义不变）。构造期副作用顺序由 hub 构造器调用次序保证（normalizeConfig →
 * registerSettings → mountPeratomStack → registerRecallTools → systemPrompt sections → ctx.on →
 * presetClean），与原先逐字一致。
 *
 * 设置页常量（ARG_SETTINGS_KEY / ArgpUserSettingsSchema / NAMESPACE_PATTERN / ARG_SETTINGS_NS）
 * 随 registerSettings 一并迁入本模块：ArgpUserSettingsSchema 是运行时值（z.object 产物），
 * 若留在 hub 会迫使本模块运行时 import hub 形成环；迁入后 hub 反向 import 本模块并 re-export，
 * 公共 API 不变（index.ts 的 `export *` 透出）。
 *
 * ArgpGraphConfig 经 type-only import 取用（编译期擦除，无运行时环）；它是 hub 侧的宽接口
 * （引用 peratom 三管线 config + PresetCleanOptions），若迁入本模块会迫使本模块 import peratom
 * 全部 config 类型，故按「深度依赖则留 hub」原则保留在 hub，本模块仅 type-only 引用。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Session } from '@deepseek-ai/dsh-session';
import type { CompactionResult, ManualCompactAgentContext } from '@deepseek-ai/dsh-compaction';
import type { CommandId } from '@deepseek-ai/dsh-commands/brand';
import z from '@deepseek-ai/schemastery';
import type { Atom, SemanticEdge, ArgpUserSettings } from './argp-types.js';
import { type TokenMeter } from './budget.js';
import { PeratomCompressor } from './peratom/compressor.js';
import { CiteDeclarer } from './peratom/cite-declarer.js';
import { RecallZoom } from './peratom/recall-zoom.js';
import type { InferredEdgeOptions } from './token-ontology.js';
import type { PrunedNodeInfo } from './prune-selection.js';
import { type GraphPruneRecord } from './prune-tx.js';
import type { ArgpGraphConfig } from './argp-graph-engine.js';
/** 设置页 namespace key（同时是 Host 服务端与客户端卡片的 key，须一致才进渲染交集）。 */
export declare const ARG_SETTINGS_KEY = "dsh-argp";
/** 引擎设置 schema（schemastery）：校验 UI 写入 + 提供 describe 视图。默认值=引擎既有默认。 */
export declare const ArgpUserSettingsSchema: z<ArgpUserSettings>;
/**
 * 窄宿主接口：本模块函数实际触达的引擎成员（字段 + 方法引用）。
 * 方法引用（shadowedSeqsOf/rebuildLedgerFromLog/restoreUsageAnchor/catalogText/bindSession）
 * 经 host 派发到 class 上的薄编排方法，运行时 this 仍是引擎实例——与原先 `this.method(...)` 一致。
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
    degradationStrategy: 'lifecycle' | 'summarize' | 'force' | 'fail';
    turnBasis: 'semantic' | 'all';
    argpSettings: ArgpUserSettings;
    settingsSource: () => ArgpUserSettings;
    maxOverflowRetries: number;
    midTurnPruneEnabled: boolean;
    midTurnLegacyGuard: boolean;
    midTurnTurnGuard: number;
    reactiveRetries: number;
    continuationNotice: string;
    onOverflowCompress?: (session: Session) => Promise<void>;
    onPrePressureCompress?: (session: Session) => Promise<void>;
    closureWindowK: number;
    citeMinPrefixLen: number;
    overlapTheta: number;
    enableOverlapChain: boolean;
    injectEdges: ((atoms: Atom[]) => SemanticEdge[]) | undefined;
    disableCiteEdges: boolean;
    disableInferredEdges: boolean;
    tombstoneMergeMinRun: number;
    inferredOpts: InferredEdgeOptions;
    peratomStack: {
        compressor: PeratomCompressor | null;
        declarer: CiteDeclarer | null;
        zoom: RecallZoom | null;
    } | null;
    citesObligation: boolean;
    citesObligationAuto: boolean;
    log: {
        info: (msg: string) => void;
        warn: (msg: string) => void;
        error: (msg: string) => void;
    };
    session: Session | null;
    rebuiltCompactionIds: Set<string>;
    frozenCatalog: string | null;
    auditWarnings: string[];
    records: GraphPruneRecord[];
    prunedNodeIndex: Map<number, PrunedNodeInfo>;
    reactivePending: WeakMap<Session, true>;
    compactSourceCommandId: CommandId | undefined;
    shadowedSeqsOf: (session: Session) => Set<number>;
    rebuildLedgerFromLog: () => void;
    restoreUsageAnchor: (session: Session) => void;
    catalogText: (maxItems?: number, snippetChars?: number, tokenBudget?: number) => string;
    bindSession: (session: Session) => void;
}
/**
 * 构造期字段归一（纯字段赋值，无 ctx 副作用）：windowTokens/retainTokens 静态默认 + 顶层旋钮
 * 缺省 + 三级触发旋钮 + 推断边参数。原先分散在构造器两处（settings 注册块前后），现合并为单一
 * 纯函数；字段赋值与任何 ctx 副作用无交互（settings 回调不读本批字段），故整体置于
 * registerSettings 之前不改变可观测行为。tokenMeter 获取（acquireTokenMeter(ctx)）是唯一的
 * ctx 读取，保持在 settings 注册之前（与原 line 541 次序一致）。
 */
export declare function normalizeConfig(ctx: Context, host: LifecycleHost, config: ArgpGraphConfig): void;
/**
 * UI 设置页注册（Settings → Plugins → Configurable → ARGP）。
 * 构造期基线 = cordis 配置（windowRatio 等顶层旋钮）；ctx.inject(['settings']) 在 settings 服务
 * 存在时注册 namespace=`dsh-argp`（base=基线），并把源 thunk 指向 scope.get()；用户经 UI 写入
 * 后 onChange 实时刷新 this.argpSettings，getter 透出即时生效（无需重启）。settings 服务缺失时
 * 优雅回退到 cordis 基线（settingsSource 保持 () => this.argpSettings）。
 */
export declare function registerSettings(ctx: Context, host: LifecycleHost, config: ArgpGraphConfig): void;
/**
 * P0 双引擎自挂载：peratom 配置块存在时，Stage-1 三管线在构造期挂载并接线
 * （与 mountPeratomStack 同拓扑：三管线 hook 注册进 ctx 事件总线，本引擎作为
 * ctx.compaction 接收 injectEdges / onOverflowCompress）。
 * ⚠️ 显式判 object（而非只判 `!== undefined`）：YAML 里"关掉 Stage-1"最自然的写法是
 * `peratom: false`，而布尔装箱后 `.compressor` 取到 undefined → `?? {}` → 三管线全挂，
 * 与写配置的人意图**完全相反**。false / null 一律按"不挂"处理（与缺省同语义）。
 *
 * 含两个构造期派生赋值：maxOverflowRetries 缺省提升（挂 compressor 时 1→3）与
 * citesObligation auto 解析（declarer 已武装即关）——两者都依赖本函数先完成 peratomStack
 * 挂载，故一并收在本函数内（保持原构造器 line 617-662 的相对次序）。
 */
export declare function mountPeratomStack(ctx: Context, host: LifecycleHost, config: ArgpGraphConfig): void;
/**
 * A7（问题 3 修订）：session 绑定统一入口——setSession / agent/pre-step / compactIfNeeded 首次绑定
 * 都走这里。绑定后若 records 为空且日志含 compaction/start 事件（resume 场景：账目丢失仅日志在），
 * 懒触发 rebuildLedgerFromLog() 自动重建；幂等由 rebuiltCompactionIds 去重保证。
 */
export declare function bindSession(host: LifecycleHost, session: Session): void;
/**
 * A7 事务账目重建：resume 时从 append-only 日志扫描 compaction/start、compaction/prune、
 * compaction/end 事件重建 records/prunedNodeIndex/shadowedSeqsOf 状态；无 end 的 start 记 warn。
 * 不引入 WAL——日志本身即账目。幂等：已重建过的 compactionId 跳过（rebuiltCompactionIds 去重），
 * 使「setSession 自动重建」与「测试显式清空 records 后再重建」两种路径都安全。
 */
export declare function rebuildLedgerFromLog(host: LifecycleHost): void;
/**
 * 反应式"零候选"重挂：把钳制信号留给下一次机会（下个 pre-step / 下一轮 turn-stopping），
 * 那时阶梯已 +1 ⇒ 守卫放宽，原本剪不动的局面（turnGuard 保护当前轮）才可能剪动。
 * 额度用尽则不再重挂（避免"每步白压"）。
 */
export declare function rearmReactive(host: LifecycleHost, session: Session, used: number): void;
/**
 * /compact 手动压缩入口（override CompactionEngine.compactNow）。
 * 统一绑定 + 账目懒重建后，选全部可剪极大段（selectManualRanges）合并为一笔事务剪除
 * （compactRegions）；runMaintenance 可用时经其执行（宿主维护窗口），否则直接跑。
 */
export declare function compactNow(host: LifecycleHost, agent: ManualCompactAgentContext, signal: AbortSignal, sourceCommandId?: CommandId): Promise<CompactionResult | null>;
