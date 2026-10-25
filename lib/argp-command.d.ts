/**
 * `/argp` 只读状态命令（1.10.0）。
 *
 * 动机：ARGP 的全部状态（预算、剪枝台账、召回命中、cites 统计）都在引擎实例里，
 * 但此前**没有任何人类可见的出口**——判断"压缩到底生效了没有"只能去翻日志。
 * 本命令把引擎的内观测面搬到一个 `/argp` 上，零模型交互、零副作用。
 *
 * ⚠️ 三条硬边界（设计约束，不是实现细节）：
 *
 * 1. **只读**：handler 只拼文本，绝不触发压缩。手动压缩走宿主官方的 `/compact`
 *    （`@deepseek-ai/dsh-command-compact`，由各 preset 层挂载），它调
 *    `ctx.compaction.compactNow(agent, signal, commandId)` —— 落到的就是本引擎。
 *    再开 `/argp compact` 只是重复入口，还多背一条 `sourceCommandId` 契约面
 *    （铁律 1③），故**不做**。
 *
 * 2. **不新增 boot 期失败面**：宿主命令服务经嵌套 `ctx.inject(['commands'], ...)`
 *    获取（与 `session-lifecycle.registerSettings` 同款）。宿主没有 commands 服务时
 *    inject 回调永不执行 ⇒ 命令静默不注册，引擎其余部分照常工作。当前正在排查
 *    dsh.so 的 L5.2 web boot 失败，任何"缺服务即抛"的写法都会污染那边的归因。
 *
 * 3. **宿主契约不自己复刻**：命令的注册/生命周期（`command/run` ↔ `command/done`）
 *    全部由宿主 `CommandRuntime` 负责，本模块只提供 `{name, description, handler}`
 *    三件套（铁律 3）。测试跑真实 `CommandRuntime`，不 mock。
 *
 * 生命周期事件由宿主写入：每次调用落 `command/run` + `command/done`（log-only，
 * 不进 model surface），与 `/compact` 同口径。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands';
import type { Session } from '@deepseek-ai/dsh-session';
import type { CiteStats } from './graph-build.js';
import type { GraphPruneRecord } from './prune-tx.js';
import type { BudgetHost } from './budget.js';
/**
 * 状态行首展示的版本号。**必须与 `package.json` 的 `version` 一致**——
 * `scripts/prerelease-check.mjs` 有断言守着（发版时忘改会直接卡住发布）。
 */
export declare const ARGP_STATUS_VERSION = "1.10.2";
/** 命令名（不带斜杠）。UI 发现列表按此展示。 */
export declare const ARGP_COMMAND_NAME = "argp";
/** 命令描述（发现 UI 的一行说明）。 */
export declare const ARGP_COMMAND_DESCRIPTION = "Show ARGP context-compression status for this session (read-only)";
/**
 * 状态渲染所需的引擎切片（窄接口）。
 *
 * 与 `LifecycleHost` / `BudgetHost` 同理：本模块只声明自己要读的字段，经
 * `this as unknown as ArgpStatusHost` 从引擎实例转换而来，不把命令模块反向
 * 耦合到 `ArgpGraphEngine` 这个大类上（也避免测试要构造整个引擎）。
 */
export interface ArgpStatusHost extends BudgetHost {
    /** 剪枝台账（有界环形缓冲，见 telemetry.pushBounded）。 */
    readonly records: GraphPruneRecord[];
    /** 召回调用记录（有界）。 */
    readonly recallCalls: {
        seq: number;
        hit: boolean;
    }[];
    /** cites 边声明统计（Stage-1 declarer 喂 Stage-2 injectEdges）。 */
    readonly citeStats: CiteStats;
    /** 已剪节点目录（seq → 元信息），供 list_pruned / recall_pruned 查询。 */
    readonly prunedNodeIndex: Map<number, unknown>;
    /** 双引擎自挂载句柄（null = 纯 Stage-2 图引擎）。诊断"双引擎到底挂没挂"的唯一出口。 */
    readonly peratomStack: {
        compressor: unknown | null;
        declarer: unknown | null;
        zoom: unknown | null;
    } | null;
    /** 在这些 preset 下引擎不生效（默认 ['minimal']）。 */
    readonly skipPresets: string[];
    /** 引擎当前绑定的会话（可能尚未绑定）。 */
    readonly session: Session | null;
    /** 会话实际运行的 preset id（无 preset 概念时 undefined）。 */
    activePresetOf(session: Session): string | null | undefined;
}
/**
 * 注册 `/argp`（幂等、可降级）。
 *
 * 与 `registerSettings` 同构：嵌套 inject 拿到 commands 服务后才注册，注册动作
 * 包在 `ctx.effect` 里（返回的 disposer 在插件卸载/重挂载时自动注销命令）。
 */
export declare function registerArgpCommand(ctx: Context, host: ArgpStatusHost): void;
/**
 * 渲染状态文本（分段详单）。纯函数，除 `measureTokens` 的读操作外无副作用。
 *
 * 段数自适应：无意义的段（如未挂 declarer 时的 cites 段）整段省略，
 * 宁可少一行也不输出恒为 0 的噪声。
 */
export declare function renderArgpStatus(host: ArgpStatusHost, invocation: Pick<CommandInvocation, 'agent'>): CommandResult;
