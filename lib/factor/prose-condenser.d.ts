import type { Context } from '@deepseek-ai/cordis';
import type { Session } from '@deepseek-ai/dsh-session';
import type { CompactionResult } from '@deepseek-ai/dsh-compaction';
import { type PruneTxHost } from '../prune-tx.ts';
import type { Atom } from '../argp-types.ts';
import { type HostReinjectedMode } from './ua-input.ts';
import { type AgentRouteHint } from '../llm/llm-adapter.ts';
/** 散文占比触发线（分母=声明窗，含 system 头）。§9.36 合取双闸之闸一（50% 线原样保留）；
 *  闸二（总上下文 ≥ windowRatio×声明窗）在引擎侧 condenseGate 把关，两闸齐过才开压。 */
export declare const PROSE_TRIGGER_RATIO = 0.5;
/** 浓缩节点文本标记（单一事实源：生成与识别同文件——VOCAB_NOTE_MARKER 同款纪律）。 */
export declare const PROSE_CHECKPOINT_PREFIX = "[\u6563\u6587\u538B\u7F29]";
/**
 * 摘要调用输出预算（§9.36 H5 终裁 2026-11-13：8192→20480——R1 回放实测两发顶到
 * 8192 顶=检查点被人为掐长；20480 ≤ 0.2×262,144=52,429 预留位内）。
 * 小声明窗守卫（H5）：实际传入 = min(本值, 0.2×声明窗 − 指令预算)，见 condense()。
 */
export declare const PROSE_SUMMARY_MAX_TOKENS = 20480;
/** 小窗守卫给指令与协议开销留的 token 数（H5 式子中的常数项）。 */
export declare const PROSE_INSTRUCTION_TOKEN_RESERVE = 512;
/**
 * §B 分派器用：摘要请求的**发送尺寸**（除上下文外的固定分量）——指令预留 + 输出
 * 预算（与 H5 小窗守卫同源）。判"能不能直发摘要求"：C + 本值 ≤ W_eff。
 */
export declare function summarySendTokens(declaredWindow: number): number;
/**
 * §G 上下文形头：输入=会话路由原样（含工具原子，逐字节复用热前缀缓存——宿主
 * compaction-basic 同款装配）。11-13 输出契约由本指令维持：工具输出体不转录，
 * 只记路径/命令/决定/结果级事实（原文经 recall_history(labels) 召回）。
 */
export declare const CTX_COMPACTION_INSTRUCTION: string;
/** 事件读侧探针（同 ua-input 口径：source.form + source.kind + 附件块）。 */
export interface ProseEventProbe {
    form?: string;
    kind?: string;
    attachment: boolean;
}
/**
 * §B-2/§C 接管授权：分派器（factor/dispatch.ts）已按「F/缺口地板/transcript 发送
 * 判据」核准浓缩，闸一双闸主权移交分派器。`maxOutputTokens`=W_eff−transcript−指令
 * 的剩余空间（可能小于 H5 标准 0.2×声明窗），发射时覆盖浓缩输出预算。缺省（未授权）
 * ⇒ 现网双闸字节不变。
 *
 * `form` 与 `approved` **正交**（2026-11-27 实测：手动 `/compact` 的摘要请求
 * 118K prompt / cached=0 / 33.3s）：
 *  - 输入形态决定前缀缓存能否复用。旧 A 形态（`buildProseMessages`）重建一份
 *    `U:/A:` transcript，**没有 system 头、正文带行内角色标记** —— 与主对话请求从
 *    第 0 个 token 就不同，必然全量未命中；
 *  - `form:'host'` 走 `buildCtxInput`（宿主同款路由装配 + 尾部指令），前缀与上一发
 *    主对话逐字节一致 ⇒ 命中到指令前（自动路径实测 ~97%）。
 * 手动压缩只需要"换输入形态"，不需要借用 `approved`（那会连带绕过散文闸一、
 * 改变淘汰口径），故单列此开关。
 */
export interface CondenseDispatch {
    approved?: true;
    form?: 'host';
    /** 仅 approved 时有意义：分派器核定的输出预算。 */
    maxOutputTokens?: number;
}
/** 轮级贪心计划（纯函数输出；发射在 ProseCondenser.condense）。 */
export interface ProseEvictPlan {
    /** 连续整轮段的 surface seqs（一笔 replace → 单浓缩节点；按 surface 位置升序）。 */
    spanSeqs: number[];
    /** 逐原子散文驱逐 seqs（破段轮；每 seq 独立区间+指针墓碑）。 */
    partialSeqs: number[];
    /** 计划驱逐的散文字符（span + partial 的 textA 文本和）。 */
    evictedProseChars: number;
    /** span（整轮晋升段）实际可驱逐的 textA 字符和——三桶 **aged 口径**（design-2.2.x §1.2）：
     *  partial 散点、barrier/洞截断段、焦点窗与 open 轮之后的 run 一律不计。 */
    spanProseChars: number;
    /** 全上下文散文字符（U/A 文本和；触发统计口径，含受保护轮）。 */
    proseCharsAll: number;
    stopReason: 'need-met' | 'exhausted' | 'no-candidate';
}
/** 贪心入参：surface 节点序 + 需释放的散文字符下界 + 保护窗。 */
export interface ProseEvictOptions {
    needChars: number;
    /** 焦点保护线：turn ≥ 该号的轮不驱逐（latestTurn − focalTurns + 1；focalTurns=0 ⇒ Infinity）。 */
    protectFromTurn: number;
    /** open turn 首节点的 surface 位置（null = 无 open turn）；run 起点 ≥ 该位置即停。 */
    openTurnFromPos: number | null;
    /** 宿主再注入三件套归类（缺省 'prose'=现网；接管授权 ⇒ 'exclude'，去重通道已闭合）。 */
    hostReinjected?: HostReinjectedMode;
}
/**
 * 轮级贪心（纯函数，单测主对象）。surface 按**连续 run** 分组（相邻同 turn 号），逐段晋升：
 * 整轮可驱逐（段内全部原子 ∈ textA/toolCallA/rPair/可吞 X，且段内有散文）→ 并入整轮段；
 * 首个破段（含 barrier/excluded-不可吞）→ 其 textA 原子逐个进 partialSeqs，贪心停止。
 */
export declare function planProseEviction(atoms: readonly Atom[], probes: ReadonlyMap<number, ProseEventProbe>, surfaceSeqs: readonly number[], options: ProseEvictOptions): ProseEvictPlan;
/** 浓缩节点文本（标记行在前：resume 找回与统计识别按 startsWith 判）。 */
export declare function proseCheckpointText(summary: string): string;
export interface ProseCondenserConfig {
    /** 焦点轮数（焦点轮不入驱逐池；同 FactorEngine 口径）。2.0.0 零旋钮：装配面传固化常量 getter。 */
    focalTurns?: number | (() => number);
    /** LLM 超时（缺省 180s）。 */
    llmTimeoutMs?: number;
    /** 测试注入：替代 dsh-llm 的补全函数（缺省走 ctx.llm + autoDshLlmSpec）。 */
    complete?: (spec: {
        provider: string;
        model: string;
    }, prompt: string, timeoutMs: number) => Promise<string>;
}
/**
 * 散文浓缩编排：触发判定 → 轮级贪心 → one-shot LLM（sys+散文 replay）→ prune-tx 发射。
 * 返回 null = 未动作（未过触发线 / 无候选 / LLM 不可用或失败）——不静默，逐条落 log。
 */
export declare class ProseCondenser {
    private readonly ctx;
    private readonly host;
    private readonly cfg;
    constructor(ctx: Context, host: PruneTxHost, config?: ProseCondenserConfig);
    /**
     * 双闸合取的闸一（散文 ≥50% 线）在本方法内查；闸二（ctx ≥ windowRatio×声明窗）由调用点
     * 保证（condenseGate / 400 事务天然满足；手动 compactNow 免闸二）。
     * windowTokens = 触发线（分母口径同旧：声明窗×windowRatio 前的声明值——引擎传缩放后
     * windowTokens，此处仅作分母）；declaredWindow = 适配器声明窗原值（H5 小窗守卫用）。
     * `dispatch`（§B-2/§C 接管）：分派器已按 F/缺口地板/transcript 判据核准浓缩——
     * 闸一双闸主权移交判据表，本方法跳过闸一；输出预算用分派器给的
     * `maxOutputTokens`（W_eff−transcript−指令 的剩余空间，可能小于 H5 标准式）。
     */
    condense(session: Session, route: AgentRouteHint, windowTokens: number, signal?: AbortSignal, declaredWindow?: number, dispatch?: CondenseDispatch): Promise<CompactionResult | null>;
    /** 焦点轮数活读：宿主侧旋钮与 FactorEngine 同源（引擎构造期传 getter 到本类）。 */
    focalTurnsOf(): number;
    /**
     * 三桶合并扫描（design-2.2.x §1.2）：一次遍历产出**同域**三桶——
     * aged（span 实际可驱逐的 textA）/ fresh（=total−aged：焦点窗、barrier/洞截断段、
     * partial 散点之后的散文）/ total（=旧 proseStats.proseCharsAll，口径逐字节不变，
     * 护住判据④ transcript 与全部旧 fixture；proseStats 由本扫描合并退役）。aged 定义直接取 planProseEviction run 分组的
     * span 晋升量——age 之外的类型/位置边界天然在内（审查实锤：年龄公式作废）。
     * 保护窗与 condense 的 plan 调用同参（清扫式 needChars=∞）：快照与浓缩之间 surface
     * 无写入点（接管形态动作序 dedup/组剪都在浓缩之后）⇒ 同面同参 ⇒ 同域 by construction。
     * 顺带产出 toolFaceChars（份额闸工具面=toolCallA+rPair，口径见 §1.3）——同一批
     * 分类结果，~免费。
     */
    scanProseBuckets(session: Session, hostReinjected?: HostReinjectedMode): {
        sysChars: number;
        totalChars: number;
        agedChars: number;
        freshChars: number;
        toolFaceChars: number;
    };
    private buildProbes;
    /** open turn 首节点 seq（detectOpenTurn 的位置版：日志尾向前找最近 turn/start）。 */
    private openTurnFirstSeq;
    /**
     * 配对闭包预检（审查 P0-2）：span 内每个 tool-call A 的全部 R 必须也在 span；
     * span 内每个有 issuer 的 R 的 issuer A 必须也在 span。孤儿 R（无 issuer）可随 span 走。
     */
    private spanPairingBalanced;
    /**
     * 驱逐 span → **散文** replay messages（2026-11-13 用户裁定：散文 = U + 无 R 的 final A）。
     * 只回放 classifyUaAtom === 'textA' 的原子；toolCallA（K）与 rPair 属 factor 协议组，
     * 不进摘要输入；excluded/barrier 同样跳过。标记 U:/A: 与指令首行一致。
     * 这是对 §9.36 "全栈 U/A+CALL/RESULT 输入" 的用户裁定反转：工具原子不再喂给摘要，
     * 由 factor 组剪（压缩检查点占位）回收，原文经 recall_history(labels) 召回。
     */
    private buildProseMessages;
    private callLlm;
    /**
     * §G 宿主同款上下文装配（buildSummarizationInput 照搬）：
     * messages = surface 头部到 span 末的**全部路由消息**（含检查点/note/钉死指令等不可驱逐
     * 头原子——它们在 wire 上就在那儿，跳过反而打断前缀），tools = requestHeader().tools，
     * route = requestHeader().config（含 reasoningEffort；与主对话同参数=命中前提）。
     * 与上一轮路由请求逐字节一致的前缀 ⇒ 服务端 warm prefix cache 命中到尾部指令为止
     * （2026-11-25 g4 实锤：只回放 span 时第 2 条摘要起前缀从 msg#1 分叉，cache 掉回
     * 1 块；头原子入队后 @102 形态 cache=24576/25283）。
     * 驱逐集合仍只有 spanSeqs——入队≠驱逐。
     */
    private buildCtxInput;
    /** §G 上下文形调用：A 形态前缀 + 尾部指令 user 消息（适配器原语），返回带 usage。 */
    private callLlmCtx;
    /** spec 解析（compressor 优先序 auto 档口径）：路由齐 + 宿主 llm 服务在位，缺一即 disabled。 */
    private resolveSpec;
}
/**
 * 浓缩输出预算（§9.36 H5 终裁）：min(20480, 0.2×声明窗 − 指令预留)——
 * 262K 声明窗下=20480（预留 52,429 tok 内）；小声明窗（如联调 32K 形：0.2×=6.5K）
 * 自动收缩，摘要调用自己永远装得下窗。declaredWindow ≤0（声明未知）⇒ 常数上限
 * （调用点已保证声明未知不进入浓缩路径，此处纯防御）。
 */
export declare function summaryMaxTokensOut(declaredWindow: number): number;
