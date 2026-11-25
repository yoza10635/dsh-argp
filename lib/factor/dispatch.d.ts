/**
 * §B 压缩分派纯函数（design-2.2 四形态分派器）。
 *
 * 单次压缩只有四种形态可选：先剪后摘 / 先摘后剪 / 仅剪 / 仅摘；外加两个非形态
 * 终态（none 无事可做 / terminal-b6 物理不可行）。本模块只做**决策**：输入快照、
 * 输出形态+理由，不读会话、不写状态、无 LLM——发射接管（§B-2）与影子日志
 * （ARGP_FACTOR_DISPATCH=1，只记录不改变发射）共用这一个函数。
 *
 * 判据口径（三域实验锁定，windowscan 2026-11-24）：
 *  - 两个分母各司其职：能不能发摘要求 = **真实上限 W_eff**（物理）；该不该摘 =
 *    W_eff 推出的 R=retain 与下限 F 的差（占比）。声明窗只经由 W_eff=min(声明,
 *    observedCap) 进来（§A），散文占比不再用 0.5×声明窗这类比例线（旧闸在
 *    declared>2(real−tools) 时死锁、declared==real 且工具占比高时漏触发）。
 *  - F = 剪光全部可剪面后的下限（b6RiskSummary 口径：非 R 原子 + 未闭合轮 R）。
 *  - 摘要有意义 ⟺ ①F−R ≥ max(proseMin, ρ·W_eff)（保留位是软目标：地板高出几个
 *    K 属可容忍超调，下一轮再剪即可——轮2 工具域实锤，ρ 缺省 0.2）∧ ②可浓缩散文
 *    ≥ F−R（浓缩器真能驱逐的 U+textA 补得上缺口）∧ ③散文量 ≥ proseMin。
 *  - 「先剪后摘」在本架构**不可达**（代码+档案双实锤 2026-11-25）：浓缩链摘要请求
 *    只回放被驱逐 span 里的 textA（U+finalA，prose-condenser.ts buildProseMessages），
 *    工具原子从不入请求——剪不剪工具，摘要请求一样大，不存在「剪后上下文的独有
 *    一次大 miss」。四形态实际塌缩为三形态（先摘后剪/仅摘/仅剪 + 两终态）；
 *    能否直发按 transcript 尺寸（可浓缩散文）而非全上下文 C 判。若未来摘要通路
 *    改为全上下文摘要（compaction-basic 式），先剪后摘才重新有意义——保留枚举位。
 */
/** 四形态 + 两终态。`prune-then-summarize` 保留枚举位但本架构不可达（见文件头），
 *  planForm 永不返回它——留待全上下文摘要通路（若未来引入）复用。 */
export type CompactForm = 'none' | 'prune-only' | 'summarize-only' | 'summarize-then-prune' | 'prune-then-summarize' | 'terminal-b6';
/** 决策快照：全部为调用点在决策时刻采好的只读标量（token 口径）。 */
export interface DispatchSnapshot {
    /** 'manual' 绕产品闸、不绕物理闸；纯函数对三种触发用同一物理判据。 */
    trigger: 'manual' | 'pressure' | 'context-overflow' | (string & {});
    /** C：当前上下文 token（测量口径，含锚点增量）。 */
    contextTokens: number;
    /** R：保留目标 token（windowTokens × retainRatio，经 capRetain）。 */
    retainTokens: number;
    /** W_eff：有效窗 = min(声明窗, observedCap)——摘要请求"能不能发"的分母。 */
    windowEff: number;
    /** F：下限 = 剪光可剪面后仍剩的 token（b6RiskSummary.nonPrunableTokens）。 */
    floorTokens: number;
    /** P：理想可剪供给 = C − F（含硬保护位；硬保护在排序层生效，不在形态层）。 */
    prunableTokens: number;
    /** 可浓缩散文：浓缩器真能驱逐的 U+textA（钉死指令/note/焦点/附件/宿主再注入不计）。
     *  摘要请求的 transcript 基底——发送可行性按它判，不按全上下文 C。 */
    condensableProseTokens: number;
    /** 摘要指令 + 摘要输出预留（标准预算；空间不足时决策内部收缩输出分量）。 */
    summarySendTokens: number;
    /** 供给余量系数 α：P ≥ α·deficit 视为剪可稳定到位（估算误差安全垫）。 */
    supplyMargin?: number;
    /** ③散文下限（非判据，防 sub-K 摘要空转）。 */
    proseMinTokens?: number;
    /** ①缺口地板比例：F−R < max(proseMin, ρ·W_eff) 视为可容忍超调，不摘（ρ 缺省 0.2）。 */
    gapFloorRatio?: number;
    /** 摘要指令 token（transcript 发送判据独立用；缺省 512 与 prose-condenser 同源）。 */
    instructionTokens?: number;
    /** 摘要输出地板：低于此值摘了也放不下像样的 checkpoint（缺省 1024）。 */
    minSummaryOutTokens?: number;
}
export interface DispatchDecision {
    form: CompactForm;
    reason: string;
    /** 摘要形态专用：W_eff − transcript − 指令 的剩余输出预算（发射时覆盖标准 0.2×W）。 */
    outBudget?: number;
}
export declare const DEFAULT_SUPPLY_MARGIN = 1.2;
export declare const DEFAULT_PROSE_MIN_TOKENS = 1536;
/** ①缺口地板：F−R 低于 max(proseMin, ρ·W_eff) = 保留位可容忍超调，摘要不值一次 miss。 */
export declare const DEFAULT_GAP_FLOOR_RATIO = 0.2;
/** transcript 安全垫：U:/A: 前缀 + 分词误差（可浓缩散文 ×1.1）。 */
export declare const TRANSCRIPT_SAFETY_RATIO = 1.1;
export declare const DEFAULT_INSTRUCTION_TOKENS = 512;
export declare const DEFAULT_MIN_SUMMARY_OUT_TOKENS = 1024;
/**
 * 决策序（定稿）：
 *  0. C ≤ R：无需压缩。
 *  1. F > W_eff：剪到头仍超真实上限 → terminal-b6（持续性 N 轮/不空转由调用方
 *     带状态处理，纯函数无状态只报形态）。
 *  2. F ≤ R：剪是唯一且够用的杠杆 → 仅剪（α 余量不足只进 reason，不改形态——
 *     摘要判据① F>R 不成立，多一次 miss 没有对象可摘）。
 *  3. F > R：缺口先过地板 max(proseMin, ρ·W_eff)——保留位是软目标，几个 K 的超调
 *     下一轮再剪即可（轮2 工具域实锤：gap 169~4894 全被旧判据放行去摘，血亏）；
 *     过得了地板再判闸②③散文是否补得上缺口：补不上 → 仅剪到下限求生
 *     （B-6 良性/焦点域：残余是 system/焦点，摘不掉）。
 *  4. 摘要值得做：发送判据按 **transcript**（摘要请求只含散文，工具不在其中）：
 *     transcript×1.1 + 指令 ≤ W_eff − 输出地板(1024) 即「摘得出去」（输出预算不足
 *     时按剩余空间收缩，§B-2 落地）→ 先摘后剪（有可剪面）/ 仅摘（无）。
 *  5. transcript 大到连收缩后的输出都放不下 → 不摘，仅剪求生（防卸;实测罕见：
 *     transcript ≤ C ≤ W_eff 量级）。
 */
export declare function planForm(s: DispatchSnapshot): DispatchDecision;
/**
 * §B 分派模式（ARGP_FACTOR_DISPATCH）：
 *  - 未设/其它 ⇒ 'off'（现网字节不变）；
 *  - '1' ⇒ 'shadow'：只记录决策（日志+文件 sink），不改变发射；
 *  - '2' ⇒ 'takeover'：按形态接管事务（结构去重 → 三形态发射；双闸主权移交判据表）。
 */
export type DispatchMode = 'off' | 'shadow' | 'takeover';
export declare function resolveDispatchMode(env?: Record<string, string | undefined>): DispatchMode;
/** 影子分派日志开关（ARGP_FACTOR_DISPATCH=1/2 都记录）：shadow 模式只记录不改发射。 */
export declare function resolveDispatchShadowEnabled(env?: Record<string, string | undefined>): boolean;
/**
 * 影子决策落盘路径（ARGP_FACTOR_DISPATCH_LOG）：DSH CLI 的 logger 不进 harness 的
 * stdout/stderr 采集面，实机三域对照必须走文件 sink（§D 影子同口径）。未设 ⇒
 * 仅走 this.log（开发环境肉眼可见），不落盘。
 */
export declare function resolveDispatchShadowLogPath(env?: Record<string, string | undefined>): string | undefined;
