import type { Context } from '@deepseek-ai/cordis';
import type { Session } from '@deepseek-ai/dsh-session';
import type { CompactionResult } from '@deepseek-ai/dsh-compaction';
import { type PruneTxHost } from '../prune-tx.ts';
import type { Atom } from '../argp-types.ts';
import { type AgentRouteHint } from '../peratom/llm-adapter.ts';
/** 散文占比触发线（分母=声明窗，含 system 头）。用户裁定 50%。 */
export declare const PROSE_TRIGGER_RATIO = 0.5;
/** 浓缩节点文本标记（单一事实源：生成与识别同文件——VOCAB_NOTE_MARKER 同款纪律）。 */
export declare const PROSE_CHECKPOINT_PREFIX = "[\u6563\u6587\u538B\u7F29]";
/** 摘要调用输出预算（maxTokens 三易其值终定 8192 的同源口径；思考型模型防烧穿）。 */
export declare const PROSE_SUMMARY_MAX_TOKENS = 8192;
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
     * 压缩事务内调用（合取的另一半由调用点保证）。windowTokens = 声明窗（分母）。
     */
    condense(session: Session, route: AgentRouteHint, windowTokens: number, signal?: AbortSignal): Promise<CompactionResult | null>;
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
    /** 被驱逐散文 → replay messages（U→user、A→assistant 纯文本；按 surface 位置序）。 */
    private buildProseMessages;
    private callLlm;
    /** spec 解析（compressor 优先序 auto 档口径）：路由齐 + 宿主 llm 服务在位，缺一即 disabled。 */
    private resolveSpec;
}
