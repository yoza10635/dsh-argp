/**
 * 每请求前缀缓存审计（2.2.3）——把「压缩有没有把前缀缓存整条打断」从
 * 首字延迟的间接推断变成 provider 账单上的直接读数。
 *
 * ## 病灶
 *
 * 实测采样（请求 13773–13775）里，一次剪枝后的首个请求出现 47s 首字延迟：
 * `47s × 5,444 tok/s ≈ 256K` prefill，而 prompt 只有 239,515——等于把保留段
 * **整条重灌**了一遍。此前只能靠「首字/速度」反推，混入了排队、采样、网络等噪声，
 * 无法区分「压缩本身的必然代价」与「目录/词表位置导致的额外重置」。
 *
 * provider 的 usage 直接给答案：`cacheReadTokens`=命中、`inputTokens`=未命中
 * （两者按 dsh-llm 契约**互斥**，cacheWriteTokens 另计）。压缩改变早期上下文后，
 * 保留段在首个请求里必然 miss 一次；之后应立刻回到高命中。于是判据是：
 *
 * - 压缩后**首请求**且命中率低 ⇒ `post-compaction-refill`（不可避免的那一次重灌）；
 * - 同一次压缩后的**第二发**仍然低命中 ⇒ 说明有额外的前缀重置源（目录/词表/系统段
 *   抖字节），这才是要追杀的对象。
 *
 * ## 边界
 *
 * 纯观测：本模块只做采样与分类，不参与任何剪枝/收敛决策。无 import（类型叶子），
 * 避免与 hub 形成环。
 */
/** 单次模型请求的缓存读数（一次 `assistant/message` 的 usage 投影）。 */
export interface RequestCacheSample {
    /** 采样时刻（墙钟 ms；仅用于展示先后与间隔，不参与判据）。 */
    at: number;
    turn: number | null;
    step: number | null;
    /** provider 账单口径的 prompt 总量 = 未命中 + 命中 + 写缓存。 */
    promptTokens: number;
    /** 命中缓存的 prompt token（`cacheReadTokens`）。 */
    cachedTokens: number;
    /** 未命中、必须真 prefill 的 prompt token（`inputTokens`）。 */
    uncachedTokens: number;
    /** 写缓存的 token（Anthropic 风格 provider 上报；OpenAI 兼容端点缺省 0）。 */
    cacheWriteTokens: number;
    /** 命中率 = cached / prompt；prompt 为 0 时记 0。 */
    hitRatio: number;
    /**
     * 本次请求所接续的最近一次成功压缩事务 id（该事务之后、下一次事务之前的所有
     * 请求都归属它；从未压缩过则 null）。**不是**"仅首请求才有"——否则无法回答
     * "同一次压缩后的第二发是否又被打断"。
     */
    compactionId: string | null;
    /** 事务结束到本次应答的毫秒数（无事务时 null）。 */
    sinceCompactionMs: number | null;
    /** 本请求是否为该事务后的首请求（判据 `post-compaction-refill` 的前提）。 */
    firstAfterCompaction: boolean;
}
/** 缓存命中形态分类。 */
export type CacheVerdict = 
/** 无归属事务、且未命中——进程/会话冷启后的首个请求（不归因于压缩）。 */
'cold-start'
/** 无归属事务、有命中——稳态续作。 */
 | 'steady'
/** 压缩后首请求、命中率高——宿主保留了可复用前缀（追加式续作）。 */
 | 'post-compaction-cached'
/** 压缩后首请求、命中率低——保留段被整条重灌（压缩的必然代价）。 */
 | 'post-compaction-refill'
/** 压缩后的**非首**请求仍然低命中——额外的前缀重置源（真正要追杀的）。 */
 | 'unexpected-refill';
/**
 * 「低命中」界线。压缩把早期历史替换成墓碑/摘要后，保留段在压缩点之后分叉，
 * 实际可复用前缀≈0；反之宿主若走追加式续作，命中率通常 > 0.9。0.5 是把
 * 「半条重灌」也算作 refill 的保守界线（宁可多报一次，不漏掉全量重灌）。
 */
export declare const REFILL_MAX_HIT_RATIO = 0.5;
/**
 * 计入「异常重灌」告警的最小 prompt。
 *
 * 不能设成几百：provider 的前缀缓存按**块**命中（实测本机端点 2048 token 一块，
 * 所有 cached 值都是 2048 的倍数），prompt 小于一两块时**结构上无法**报出命中——
 * 那是"块粒度未达"，不是"续作又失配"。8K ≈ 4 块，足以区分两者；更小的 prompt
 * 即使整条重灌也不贵，不值得告警。
 */
export declare const REFILL_MIN_PROMPT_TOKENS = 8192;
/** 采样入参（引擎侧只做字段搬运，判据留在这里，便于单测锁死）。 */
export interface RequestCacheInput {
    at: number;
    turn: number | null;
    step: number | null;
    inputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    /** 本次请求所接续的最近一次成功压缩事务（无则 null）。 */
    compaction: {
        id: string;
        at: number;
    } | null;
    /** 该事务后尚无应答 ⇒ true（引擎维护的"首请求"游标）。 */
    firstAfterCompaction: boolean;
}
/** 由 usage 分量构造一条采样（唯一构造出口，保证互斥口径不被各调用点写歪）。 */
export declare function buildRequestCacheSample(input: RequestCacheInput): RequestCacheSample;
/** 采样分类（`post-compaction-refill` 之外的低命中都算意外）。 */
export declare function classifyCacheSample(sample: RequestCacheSample): CacheVerdict;
/**
 * 是否应报「异常重灌」：压缩后首请求的低命中是必然代价（记 info 即可），
 * 真正异常的是**同一次压缩之后**的续作仍低命中——那说明还有别的东西在抖前缀。
 * 调用方对首请求与续作分别决定日志级别，判据本身只回答「低命中且值得注意」。
 */
export declare function isLowCacheHit(sample: RequestCacheSample): boolean;
