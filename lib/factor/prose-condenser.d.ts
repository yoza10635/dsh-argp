import type { Context } from '@deepseek-ai/cordis';
import type { Session } from '@deepseek-ai/dsh-session';
import type { CompactionResult } from '@deepseek-ai/dsh-compaction';
import { type PruneTxHost } from '../prune-tx.ts';
import type { Atom } from '../argp-types.ts';
import { type AgentRouteHint } from '../peratom/llm-adapter.ts';
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
/** 事件读侧探针（同 ua-input 口径：source.form + 附件块）。 */
export interface ProseEventProbe {
    form?: string;
    attachment: boolean;
}
/** 轮级贪心计划（纯函数输出；发射在 ProseCondenser.condense）。 */
export interface ProseEvictPlan {
    /** 连续整轮段的 surface seqs（一笔 replace → 单浓缩节点；按 surface 位置升序）。 */
    spanSeqs: number[];
    /** 逐原子散文驱逐 seqs（破段轮；每 seq 独立区间+指针墓碑）。 */
    partialSeqs: number[];
    /** 计划驱逐的散文字符（span + partial 的 textA 文本和）。 */
    evictedProseChars: number;
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
    /** 焦点轮数（焦点轮不入驱逐池；同 FactorEngine 口径）。设置卡旋钮 → 引擎侧传 getter 活读。 */
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
     */
    condense(session: Session, route: AgentRouteHint, windowTokens: number, signal?: AbortSignal, declaredWindow?: number): Promise<CompactionResult | null>;
    /** 焦点轮数活读：宿主侧旋钮与 FactorEngine 同源（引擎构造期传 getter 到本类）。 */
    focalTurnsOf(): number;
    /** 散文占比统计（触发线日志/遥测复用；不读 LLM）。 */
    proseStats(session: Session): {
        sysChars: number;
        proseCharsAll: number;
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
