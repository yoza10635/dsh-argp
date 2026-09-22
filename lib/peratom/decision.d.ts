import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type { CompressDecision, CurrentTurnCollect, PlanOptions } from './compressor-types.js';
/**
 * 防御性 JSON 提取（spike 32 extractJson 原样复刻）：剥 <think>、剥代码围栏、
 * 从最后一个 } 向前找配对 {。response_format 失效的端点上兜底。
 */
export declare function extractJson(raw: string): unknown;
/** 模型输出 → CompressDecision（信任边界：seq/quotes/level/text 全字段校验，异形丢弃）。 */
export declare function normalizeDecision(cand: unknown): CompressDecision | null;
interface PlannedStep {
    kind: 'replace' | 'append';
    type: 'user/message' | 'tool/result';
    /** replace 的目标 seq（append 时无意义）。 */
    at: number;
    data: unknown;
    sourceEventSeqs: number[];
}
interface PlanResult {
    steps: PlannedStep[];
    replaces: number;
    skippedFallbackDialog: number;
    skippedFidelity: number;
    /** 模型显式选 false（不压）的 tool 原子数（设计对称：与 info 同级显式信号）。 */
    skippedFalse: number;
    /** no-op 守卫拒的 tool 副本数（收益 ≤5% 视同 false；spike 37 全文照抄实锤驱动）。 */
    skippedNoopGain: number;
    /** 被保真守卫拒的副本中，缺失的高信号 token 汇总（诊断"白压"根因用）。 */
    fidelityMissing: string[];
    /** summary 副本审计：被概括丢弃的高信号 token（放行但入账，供审核）。 */
    summaryDropped: string[];
    /** HLS 修复档（v1.2.0 组件 B）：extract 被拒后经守卫尾注补全落地的副本数。 */
    hlsRepairs: number;
    /** HLS 审计台账：守卫补进尾注的高信号 token（与 summaryDropped 同级可审，spike39 消费）。 */
    restoredByGuard: string[];
    /**
     * HLS 经济学门控拒收数（v1.2.0 门控修正）：候选虽缺 token 但 ROI = 净释放/尾注 < θ
     * （尾注不划算，修复后接近/超过原文长度）→ 退回原文保面。与 skippedFidelity 同向
     * （原子保原文），单列以便度量「代价盲区间」（spike39 的 F1/F4 形态）的出现频率。
     */
    hlsRoiSkipped: number;
    anomalies: number;
}
/**
 * tool/result replace 副本载荷。dsh-session 硬约束："tool/result surface replacement
 * may change only content"——替换数据与原文除 message.content[0].content 外必须逐键
 * 深度相等，因此**不能**携带 data[ARG_NS] 元数据（多余键即拒绝）。
 * summary 语义由副本正文本身承载；P3 recall_summary 对无 data[ARG_NS].summary 的节点
 * 按设计降级返回 extract 副本文本，信息无损。防再压缩由版本链索引天然兜住：
 * 原文与副本同 (tool|args) 键 → 计数 ≥2 → 双双硬排除。
 */
/**
 * tool/result 压缩副本的头部标记（v1.6.1）：`[已压缩-摘取 seq=N]` / `[已压缩-摘要 seq=N]`。
 *
 * **为什么必须存在**：副本在 LLM 侧与真实工具输出不可辨。extract 档的 text 按 prompt
 * 契约是原文**逐字**片段（`prompt.ts` PROMPT_RULES「逐字完整拷贝」），模型无从判断它
 * 是片段还是完整输出；summary 档的 text 是概括，模型可能把概括措辞当原文引用——
 * 而 `argp-cites` 协议要求「copy verbatim the first 10-20 words」，引用压缩态措辞
 * 会指向日志里不存在的串（引用图错边）。分档标记顺带给出「这段措辞是原文还是改写」
 * 的信号，成本与单一标记等同（同字数）。
 *
 * **为什么带 seq**：seq 是日志内部序号，模型在 tool/result 消息里看不到它。不带 seq，
 * 即便 system 契约写了「用 recall_detail 找回」，模型也无参数可调 ⇒ 召回通路实际是断的。
 * 图剪墓碑把 seq 写进正文（`[elided seq=N..M]`，`prune-tx.ts`）正是同一理由。
 * N 取**原事件 seq**（= `action.seq`）：recall 工具索引 append-only 日志，原文事件
 * 仍在其中，传原 seq 即取回原文。
 *
 * **召回指引不写在这里**：每原子重复一段指引纯属浪费上下文，统一由 system 提示词
 * 的 `argp-recall-zoom` / `argp-contract` 静态段一次性说明（静态 = 不破坏前缀缓存）。
 *
 * ⚠️ 自指陷阱：本字面量会进入语料正文。语料侧统计（压缩计数 / 保真统计）须按
 * `^\[已压缩-(摘取|摘要) seq=\d+\]\n` 剥离后再算，否则重复 `[restored]`/`cites`
 * 字面量假阳性的老问题。
 */
export declare function toolCopyMarkerText(level: 'extract' | 'summary', seq: number): string;
/** 剥离副本头部标记的正则（语料侧审计 / 测试共用；只匹配行首单行标记）。 */
export declare const TOOL_COPY_MARKER_RE: RegExp;
/**
 * 引擎侧规划：模型输出过信任边界（seq 必须命中本轮收集集，先到先得去重），
 * 用户消息过 resolveSplit 全套保守策略（定位失败回退 dialog / 覆盖率翻转 / 空隙归 info）。
 * 返回落盘步骤序列；steps 为空 = 本轮无可落地动作（不开发务括号）。
 */
export declare function planReplacements(collect: CurrentTurnCollect, decision: CompressDecision, events: readonly SessionEvent[], opts?: PlanOptions): PlanResult;
export {};
