/**
 * ARGP 预算/度量模块（P5 结构重构 Wave 3 第 4 步，C 报告 §4 A 表）。
 *
 * 从 3,380 行 hub `argp-graph-engine.ts`（God Class）拆出的**预算侧**函数：
 * 比例预算纯函数（scaleBudgets）+ token-meter 获取（acquireTokenMeter）+
 * surface 可见字符（visibleChars）+ 预算解析（resolveScaledBudgets）+
 * token 测量（measureTokens）。
 *
 * 循环 import 规避（C 报告关键设计决策 1）：本模块**不** import hub 运行时。
 * 需要读/写引擎可变字段的函数（resolveScaledBudgets / measureTokens）接收窄接口
 * {@link BudgetHost} 而非具体 class；hub 的 class 以 `this as unknown as BudgetHost`
 * 传入（编译期断言，运行时即真实实例，私有字段经 host 类型可读写/重赋值）。
 * 依赖方向：hub → budget（单向）。
 *
 * 行为逐字节不变：函数体逻辑逐字保留（this.x → host.x），仅 `this` 换 `host`。
 * scaleBudgets / visibleChars / acquireTokenMeter 为纯函数（无 this）。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Session } from '@deepseek-ai/dsh-session';
import type { CompactionAgentContext } from '@deepseek-ai/dsh-compaction';
/** 比例预算纯函数：window = ctx × windowRatio；retain = window × retainRatio（缺省回退）。导出供测试。 */
export declare function scaleBudgets(contextWindow: number | undefined, opts: {
    windowRatio?: number;
    retainRatio?: number;
    explicitWindow?: number;
    explicitRetain?: number;
    fallbackWindow?: number;
    fallbackRetain?: number;
}): {
    windowTokens: number;
    retainTokens: number;
};
/** dsh token-meter 服务的最小结构（measure 返回 total/surface token）。 */
export interface TokenMeter {
    measure(session: Session): {
        totalTokens: number;
        surfaceTokens: number;
    };
}
/**
 * 从 ctx 获取 dsh token-meter 服务（构造期；缺失时 undefined）。
 * 原 constructor 内联 try/catch 段提升为纯函数：tokenMeter 不作为 required inject
 * （避免测试/最小化组合缺少该服务时构造失败），运行时尝试从 ctx 获取；真会话中
 * dsh-token-meter 已挂载即可使用。
 */
export declare function acquireTokenMeter(ctx: Context): TokenMeter | undefined;
/** surface 可见字符总量（与 spike 4 同基准）。原 class 私有方法，纯函数（无 this）。 */
export declare function visibleChars(session: Session): number;
/**
 * 预算/度量模块函数访问引擎状态所需的窄接口（C 报告关键设计决策 1）。
 * 仅列出 resolveScaledBudgets / measureTokens 实际读写的字段；
 * hub 的 ArgpGraphEngine 以 `this as unknown as BudgetHost` 满足它。
 * windowRatio/retainRatio/charsPerToken 在 class 上是 getter——经 host 读取时
 * getter 以真实实例为 this 调用，语义与 this.windowRatio 完全一致。
 */
export interface BudgetHost {
    explicitWindowTokens: boolean;
    windowTokens: number;
    explicitRetainTokens: boolean;
    retainTokens: number;
    declaredContextWindows: WeakMap<Session, number>;
    log: {
        info: (msg: string) => void;
        warn: (msg: string) => void;
        error: (msg: string) => void;
    };
    windowRatio: number;
    retainRatio: number;
    resolvedWindowTokens: number;
    charsPerToken: number;
    lastRealAnchorSeq: number;
    lastRealPromptTokens: number;
    tokenMeter: TokenMeter | undefined;
    tokenMeterFn?: (session: Session) => {
        contextTokens: number;
        surfaceTokens: number;
    };
    ctx: Context;
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
export declare function resolveScaledBudgets(host: BudgetHost, agent: CompactionAgentContext): Promise<{
    windowTokens: number;
    retainTokens: number;
    declaredKnown: boolean;
}>;
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
export declare function measureTokens(host: BudgetHost, session: Session, extraTokens?: number): {
    contextTokens: number;
    surfaceTokens: number;
    source: 'anchored' | 'tokenMeter' | 'config' | 'chars';
};
