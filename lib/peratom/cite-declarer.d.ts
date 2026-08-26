/**
 * CiteDeclarer（Stage-1 建图侧，plan P2）：轮末引用边声明管线。
 *
 * 宿主身份（plan §0）：**普通 cordis 服务，非 ctx.compaction 位**——与 PeratomCompressor
 * 并列走事件钩子，Stage-2 的 ArgpGraphEngine 独占 compaction 位，零改动消费边（见
 * `buildInjectEdges`，plan §0 第 2 点"injectEdges 通道已存在，Stage-2 零改动"）。
 *
 * 职责：每轮末声明"当轮行为原子（U/A）引用了哪些窗口内的数据原子（U/R）"，产边缓存
 * 到 seq 空间，Stage-2 每次建图经 `buildInjectEdges(atoms)` 取边并做 seq→id 映射。
 *
 * 触发（与 PeratomCompressor 的 idle prepare 同钩子、互相独立）：`agent/status: idle`。
 * 此刻当轮已闭、原子仍在原始形态、turn 归属正确。注意：compressor 的 replace flush
 * 发生在下一次 agent/pre-step（晚于本钩子），本钩子看到的是原始形态原子；flush 后某些
 * fromSeq 可能被影子化，对应边在建图时因端点离 surface 被 buildGraph 天然丢弃（优雅降级，
 * 不破坏 toSeq 的保护语义）。
 *
 * 失败隔离（plan P2）：LLM 调用失败 / 解析失败 → 记 failed 计数、本轮无边、静默重试至多
 * 1 次（response_format 被拒时降级裸 prompt，compressor 同款）；`buildInjectEdges` 吞一切
 * 异常恒返回 `[]`——declarer 故障绝不阻断 Stage-2 建图或会话（plan §0 第 3 点"失败隔离
 * 免费获得"）。
 *
 * 孤立原子规则（plan P2，与 gate.ts 共用谓词自动一致）：门控跳过的轮次（纯 dialog /
 * 全版本链 / 全小结果 / 中断轮）不调用、不建边。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Session } from '@deepseek-ai/dsh-session';
import type { Atom, SemanticEdge } from '../argp-graph-engine.js';
import type { GateAtom } from './gate.js';
/** 声明窗口（plan P2 决策⑥起步值）：当轮行为原子 + 近 N 轮数据原子。 */
export declare const CITATION_WINDOW_TURNS = 10;
/** 声明边级别（直接复用 Stage-2 的 EdgeLevel 值域）。 */
export type DeclaredLevel = 'critical' | 'supporting' | 'contextual';
/**
 * 声明输出 schema（信任边界）：from=当轮行为原子（引用方）、to=窗口内数据原子（被引用方）、
 * level 三档。fromSeq/toSeq 必须是本次 prompt 实际给出的 seq（消费时二次校验）。
 */
export interface DeclaredCite {
    fromSeq: number;
    toSeq: number;
    level: DeclaredLevel;
}
/** 参与声明的原子视图（prompt 暴露 + 信任边界校验的 seq 集合）。 */
export interface DeclAtom {
    seq: number;
    /** 所属轮次（中断轮过滤 + 诊断）。 */
    turn: number;
    /** 来源事件类型（prompt 语义提示）。 */
    kind: 'user' | 'assistant' | 'tool-result';
    /** 行为原子（U 消息 / A 回复）：只作 from 端点（引用方）。 */
    isFrom: boolean;
    /** 数据原子（U / R）：只作 to 端点（被引用方）。 */
    isTo: boolean;
    /** 角色标签（喂给模型的语义提示：current=当轮 / prior=近轮）。 */
    role: 'current' | 'prior';
    /** 模型可见文本（超 PROMPT_ATOM_CHAR_CAP 截断）。 */
    text: string;
}
/** 一次声明尝试的观测记录（测试直接读这里）。 */
export interface CiteRecord {
    at: string;
    turn: number;
    called: boolean;
    ms?: number;
    /**
     * 失败 / 跳过原因（重试耗尽后的最终态）：
     * - 'parse-failed'：响应无法解析为 {cites:[...]}（本轮无边，安全方向）；
     * - 'interrupted-turn'：中断轮零声明；'gate-skipped'：孤立原子规则零声明；
     * - 'no-endpoint'：disabled 配置零声明；其余为网络 / 超时错误文本。
     */
    error?: string;
    /** 解析成功但越界（fromSeq/toSeq 不在给定集合）的边数。 */
    invalid?: number;
    /** 采纳入缓存的边数。 */
    accepted?: number;
    /** 声明边快照（诊断 / 测试断言用）。 */
    cites?: DeclaredCite[];
}
export interface CiteDeclarerConfig {
    /** OpenAI 兼容 chat/completions 端点全 URL。缺省按环境变量解析（见 citeDeclarerDefaultEndpoint）。 */
    endpoint?: string;
    apiKey?: string;
    model?: string;
    /** 声明窗口轮数（默认 CITATION_WINDOW_TURNS=10）。 */
    windowTurns?: number;
    /** 单次请求超时（默认 120s，边声明比压缩轻）。 */
    timeoutMs?: number;
    /** 追加到请求体的模板参数（本地 llama.cpp + Qwen 的 { enable_thinking: false } 等）。 */
    chatTemplateKwargs?: Record<string, unknown>;
    /** fetch 注入点（测试替身；生产缺省 globalThis.fetch）。 */
    fetchImpl?: typeof fetch;
}
interface ResolvedEndpoint {
    endpoint: string;
    model: string;
    apiKey: string;
}
/**
 * 缺省端点解析：与 PeratomCompressor 同口径（ARGP_MODEL_SOURCE=qwen-local → 本地；
 * 否则 DeepSeek 生产端点）。apiKey 缺失 → disabled（静默跳过，零网络副作用）——
 * declarer 可独立关闭（plan P2 验收判据 3 的"不挂载"路径）。
 */
export declare function citeDeclarerDefaultEndpoint(env?: NodeJS.ProcessEnv): ResolvedEndpoint | null;
/**
 * 模型输出 → DeclaredCite[]（信任边界）：fromSeq 必须在 isFrom 集合、toSeq 必须在 isTo
 * 集合、from≠to、level 三档；越界 / 异形边丢弃并计入 invalid。同 (from,to) 重复合并
 * 保留最高 level（critical > supporting > contextual）。
 */
export declare function normalizeCites(cites: readonly unknown[], fromSeqs: ReadonlySet<number>, toSeqs: ReadonlySet<number>): {
    cites: DeclaredCite[];
    invalid: number;
};
/** collectDeclAtoms 产物：声明窗口内全部原子 + 当轮门控原子。 */
export interface DeclCollect {
    turn: number;
    /** 当轮命中中断标记：from/to 恒空，调用门控必然短路（零 LLM 调用）。 */
    interrupted: boolean;
    /** 当轮门控原子（user-long + tool-result）：喂 turnCompressible，与 compressor 共用谓词。 */
    gateAtoms: GateAtom[];
    /** 当轮行为原子（U 任意长度 / A 回复）：只作 from 端点。 */
    fromAtoms: DeclAtom[];
    /** 近轮窗口数据原子（U / R）：只作 to 端点（已剔除中断轮残留）。 */
    toAtoms: DeclAtom[];
}
/**
 * 收集声明窗口：当轮（最新闭合 turn）行为原子 + 近 windowTurns 轮（closed-N..closed-1）
 * 数据原子 + 当轮门控原子。turn 归属与 compressor collectCurrentTurn 同口径：
 * user/message 无 turn 字段（rc.2）→ 归属当前开放 turn；assistant/tool 自带 turn。
 */
export declare function collectDeclAtoms(session: Session, windowTurns: number, splitThresholdChars: number): DeclCollect | null;
export declare class CiteDeclarer {
    static inject: readonly [];
    readonly windowTurns: number;
    readonly timeoutMs: number;
    private readonly ctx;
    private readonly endpoint;
    private readonly fetchImpl;
    private readonly chatTemplateKwargs;
    /** seq 空间声明边缓存：(fromSeq->toSeq) → 边。消费端 buildInjectEdges 做 seq→id 映射。 */
    private readonly edgeCache;
    /** 防重复 turn 处理：(session, turn) 记账于声明阶段。 */
    private readonly doneTurns;
    /** LLM 声明调用计数器（门控跳过 / 中断 / disabled 轮零调用的断言读这里）。 */
    private _calls;
    get calls(): number;
    /** 全部声明尝试记录（时间序）。 */
    readonly records: CiteRecord[];
    /** 缓存中的声明边数（测试断言用）。 */
    get cachedEdgeCount(): number;
    constructor(ctx: Context, config?: CiteDeclarerConfig);
    /**
     * idle 触发段（公开入口供单测 / P4 直驱）：幂等记账 → 中断轮短路 → 孤立原子门控
     * （turnCompressible 共用谓词）→ disabled 短路 → LLM（1 次静默重试）→ 边入缓存。
     * 返回观测记录；无可声明轮（无闭合 turn）返回 null。
     */
    declareCurrentTurn(session: Session): Promise<CiteRecord | null>;
    /** 边入缓存：同 (from,to) 覆盖（后轮声明刷新 level）；超限按插入序淘汰最旧。 */
    private cacheCites;
    /**
     * Stage-2 接线点（ArgpGraphEngineConfig.injectEdges 回调）：seq→id 映射。
     * 吞一切异常恒返回 `[]`——declarer 故障绝不阻断建图（plan P2 失败隔离）。
     * 端点已离 surface 的边：buildGraph 的 validIds 校验（atom.id 集合）天然丢弃（优雅降级）。
     * 注意：buildGraph 校验空间是**本次投影内的 atom.id**（局部索引），不是 seq——
     * 故缓存保持 seq 空间，本方法每次建图现映射。
     */
    buildInjectEdges(atoms: Atom[]): SemanticEdge[];
}
export {};
