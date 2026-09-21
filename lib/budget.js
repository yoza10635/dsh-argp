import { DEFAULT_WINDOW_TOKENS, DEFAULT_RETAIN_TOKENS, DEFAULT_WINDOW_RATIO, DEFAULT_RETAIN_RATIO } from './constants.js';
import { eventText } from './log-access.js';
/** 比例预算纯函数：window = ctx × windowRatio；retain = window × retainRatio（缺省回退）。导出供测试。 */
export function scaleBudgets(contextWindow, opts) {
    const windowRatio = opts.windowRatio ?? DEFAULT_WINDOW_RATIO;
    const retainRatio = opts.retainRatio ?? DEFAULT_RETAIN_RATIO;
    if (opts.explicitWindow !== undefined && opts.explicitRetain !== undefined) {
        return { windowTokens: opts.explicitWindow, retainTokens: opts.explicitRetain };
    }
    if (contextWindow === undefined || contextWindow <= 0) {
        return { windowTokens: opts.fallbackWindow ?? DEFAULT_WINDOW_TOKENS, retainTokens: opts.fallbackRetain ?? DEFAULT_RETAIN_TOKENS };
    }
    const windowTokens = opts.explicitWindow ?? Math.floor(contextWindow * windowRatio);
    const retainTokens = opts.explicitRetain ?? Math.floor(windowTokens * retainRatio);
    return { windowTokens, retainTokens };
}
/**
 * 从 ctx 获取 dsh token-meter 服务（构造期；缺失时 undefined）。
 * 原 constructor 内联 try/catch 段提升为纯函数：tokenMeter 不作为 required inject
 * （避免测试/最小化组合缺少该服务时构造失败），运行时尝试从 ctx 获取；真会话中
 * dsh-token-meter 已挂载即可使用。
 */
export function acquireTokenMeter(ctx) {
    try {
        return ctx.tokenMeter ?? ctx.get?.('tokenMeter');
    }
    catch {
        return undefined;
    }
}
/** surface 可见字符总量（与 spike 4 同基准）。原 class 私有方法，纯函数（无 this）。 */
export function visibleChars(session) {
    let total = 0;
    for (const seq of session.surface.nodes)
        total += eventText(session, seq).length;
    return total;
}
/**
 * 预算解析：显式配置用显式值；否则从适配器声明的 contextWindow 按比例推导——
 *  windowTokens = contextWindow × windowRatio（默认 0.8），retainTokens = windowTokens × retainRatio（默认 0.2）。
 *  上下文容量由其他插件（模型适配器声明）决定，本引擎不硬编码。
 *  解析顺序：1) session.requestContext()（request/context 事件，真会话最可靠）；
 *           2) llm.resolveModelInfo(provider, model)；3) 静态默认值。
 *
 * 原 class 私有方法；this.x → host.x（resolvedWindowTokens 经 host 重赋值落到真实字段）。
 */
export async function resolveScaledBudgets(host, agent) {
    const explicitWindow = host.explicitWindowTokens ? host.windowTokens : undefined;
    const explicitRetain = host.explicitRetainTokens ? host.retainTokens : undefined;
    let contextWindow;
    // 1) 真会话中 request/context 事件会写入 session.requestContext()，优先读取。
    try {
        const reqCtx = agent.session.requestContext?.();
        if (reqCtx?.contextWindow !== undefined && reqCtx.contextWindow > 0) {
            contextWindow = reqCtx.contextWindow;
        }
    }
    catch {
        contextWindow = undefined;
    }
    // 1.5) 声明窗口缓存（request/context 事件的 WeakMap 副本）：覆盖 requestContext()
    // 尚未落账但事件已流经的时序（pre-step 检查早于首个请求的落账窗口）。
    if (contextWindow === undefined) {
        const cached = host.declaredContextWindows.get(agent.session);
        if (cached !== undefined && cached > 0)
            contextWindow = cached;
    }
    // 2) fallback 到 llm.resolveModelInfo（旧路径/测试路径）。
    if (contextWindow === undefined) {
        try {
            const provider = agent.options?.provider;
            const model = agent.options?.model;
            const llm = host.ctx.get('llm');
            if (llm?.resolveModelInfo !== undefined && provider !== undefined && model !== undefined) {
                // P1.3（2026-09-21）：旧代码用 new AbortController().signal 但该 controller 从未被
                // abort——LLM 服务挂起时这个 await 无限阻塞 pre-step（外层 try/catch 只对 rejection
                // 生效，对 hang 无效）。5s 超时把 hang 转成 rejection，落入既有 contextWindow=
                // undefined 降级（declaredKnown=false 路径，宁缺勿错）。
                const ac = new AbortController();
                const t = setTimeout(() => ac.abort(), 5000);
                try {
                    const info = await llm.resolveModelInfo(provider, model, ac.signal);
                    contextWindow = info.context?.contextWindow;
                }
                finally {
                    clearTimeout(t);
                }
            }
        }
        catch {
            contextWindow = undefined;
        }
    }
    // 3) 声明值完全未知（新会话首个 pre-step，且探测路径不可信/缺失）：标记
    // declaredKnown=false，宁缺勿错——物理窗口口径（llama.cpp n_ctx）会让阈值放大
    // 7×+，形同禁用。显式配置 windowTokens 的场景不依赖声明值，不受影响。
    const declaredKnown = explicitWindow !== undefined
        || (contextWindow !== undefined && contextWindow > 0);
    if (!declaredKnown) {
        host.log.info('[argp-graph] declared contextWindow not yet known; early pressure checks will skip until the first request/context lands');
    }
    const scaled = scaleBudgets(contextWindow, {
        explicitWindow, explicitRetain,
        windowRatio: host.windowRatio, retainRatio: host.retainRatio,
        fallbackWindow: host.windowTokens, fallbackRetain: host.retainTokens,
    });
    host.resolvedWindowTokens = scaled.windowTokens;
    return { ...scaled, declaredKnown };
}
/** 测量当前上下文 token。优先「真实 usage 锚点 + 增量估算」（2026-08-23，
 *  替代 tokenMeter chars/4 低估导致的迟触发/窗口保护失效）；无锚点才回退
 *  dsh tokenMeter / 配置函数 / 字符估算。source 标注估计来源（2026-08-29：
 *  压力日志与实验审计需要区分 anchored 真值路径与启发式回退路径）。
 *  `extraTokens`（1.4.0）：本步**已 claim 但尚未落盘**的 user 消息估值。轮初它既不在
 *  surface 里、也不在锚点覆盖范围内，漏掉就等于漏算"这一轮的启动量"——而用户恰恰
 *  常在轮初粘贴大段文本，正是 1.3.x 轮初估值偏低的直接原因。
 *
 * 原 class 私有方法；this.x → host.x。
 */
export function measureTokens(host, session, extraTokens = 0) {
    const surfaceTokens = Math.ceil(visibleChars(session) / host.charsPerToken);
    if (host.lastRealAnchorSeq >= 0 && host.lastRealPromptTokens > 0) {
        // 真实锚点（上轮 provider usage）只覆盖锚点 seq 之前的内容；其后 surface 新增
        // 节点（user/assistant/tool 事件）按字符估算增量。增量通常远小于全量，估算偏差
        // 只作用于增量 → 总误差从 ±30% 降到几个百分点。已知局限（均为保守或单步窗口）：
        // ① peratom 替换旧节点（seq ≤ 锚点）减量不计 → 高估 → 剪早（保守方向）；
        // ② 压缩换代后锚点重置为纯 surface 估算（不含 system+tools）→ 低估一个 step，
        //    下一次 assistant/message usage 回到精确锚定。
        let deltaChars = 0;
        for (const seq of session.surface.nodes) {
            if (seq > host.lastRealAnchorSeq)
                deltaChars += eventText(session, seq).length;
        }
        const deltaTokens = Math.ceil(deltaChars / host.charsPerToken);
        return { contextTokens: host.lastRealPromptTokens + deltaTokens + extraTokens, surfaceTokens, source: 'anchored' };
    }
    if (host.tokenMeter !== undefined) {
        try {
            const m = host.tokenMeter.measure(session);
            return { contextTokens: m.totalTokens + extraTokens, surfaceTokens: m.surfaceTokens, source: 'tokenMeter' };
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            host.log.warn('[argp-graph] tokenMeter.measure failed, falling back: ' + message);
        }
    }
    if (host.tokenMeterFn !== undefined) {
        const measured = host.tokenMeterFn(session);
        return { ...measured, contextTokens: measured.contextTokens + extraTokens, source: 'config' };
    }
    return { contextTokens: surfaceTokens + extraTokens, surfaceTokens, source: 'chars' };
}
