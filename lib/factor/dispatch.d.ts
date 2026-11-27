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
 *    ≥ F−R（浓缩器真能驱逐的 U+textA 补得上缺口）∧ ③散文量 ≥ proseMin ∧ ④发送可行。
 *  - **④ 发送可行性以 host 形态为准**（2.3.0 起唯一发射形态；2026-11-27 修正）：摘要请求
 *    回放 **surface 头到 span 末的全部路由消息 + tools 声明 + 尾部指令**
 *    （prose-condenser buildCtxInput），其规模上界就是当前上下文 C。旧口径按 legacy
 *    A 形态只算可浓缩散文 transcript，会把输出预算高估到越界——摘要请求自己撞窗
 *    （B2）。因此「剪不剪工具，摘要请求一样大」的旧论证同时失效。
 *  - 「先剪后摘」仍**不发射**：先剪会打断热前缀，摘要从 ~98% 命中掉回全量 prefill；
 *    热前缀装不下时的正确动作是本轮仅剪，等下一轮新前缀热起来再摘。枚举位保留。
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
     *  **不再用于发送可行性**（2.3.0 起按 host 形态的 C 判）；仍作 aged 缺省回退与散文供给口径。 */
    condensableProseTokens: number;
    /** 三桶 aged 口径：span 实际可驱逐的 textA（barrier/洞截断段、partial 散点、焦点窗
     *  之后的 run 一律不计）。**可选**——缺省回退 condensableProseTokens（total）：
     *  回退只保证**口径输入**不变（判据④ 也已是 host 口径）；旧 fixture 的判形可能与
     *  2.2.0 不同（T42 型翻转即预期），勿在旧快照上锁决策级字节兼容断言。 */
    condensableProseAgedTokens?: number;
    /** 摘要指令 + 摘要输出预留（标准预算；空间不足时决策内部收缩输出分量）。 */
    summarySendTokens: number;
    /** 供给余量系数 α：P ≥ α·deficit 视为剪可稳定到位（估算误差安全垫）。 */
    supplyMargin?: number;
    /** ③散文下限（非判据，防 sub-K 摘要空转）。 */
    proseMinTokens?: number;
    /** ①缺口地板比例：F−R < max(proseMin, ρ·W_eff) 视为可容忍超调，不摘（ρ 缺省 0.2）。 */
    gapFloorRatio?: number;
    /** 工具面 token（口径=toolCallA+rPair 文本和；附件 R 落 barrier 类=低估、
     *  toolCallA 含 final-A 散文=高估，两向偏差入档 design-2.2.x §1.3）。
     *  **可选**——缺省 0 ⇒ 份额闸永不触发，旧快照/旧 fixture 字节不变。 */
    toolFaceTokens?: number;
    /** 摘要指令 token（发送判据用；缺省 512 与 prose-condenser 同源）。 */
    instructionTokens?: number;
    /** 摘要输出地板：低于此值摘了也放不下像样的 checkpoint（缺省 1024）。 */
    minSummaryOutTokens?: number;
}
export interface DispatchDecision {
    form: CompactForm;
    reason: string;
    /** 摘要形态专用：W_eff − host prompt(C) − 指令 − 面余量 的剩余输出预算（发射时覆盖标准 0.2×W）。 */
    outBudget?: number;
}
export declare const DEFAULT_SUPPLY_MARGIN = 1.2;
export declare const DEFAULT_PROSE_MIN_TOKENS = 1536;
/** ①缺口地板：F−R 低于 max(proseMin, ρ·W_eff) = 保留位可容忍超调，摘要不值一次 miss。 */
export declare const DEFAULT_GAP_FLOOR_RATIO = 0.2;
/** ②开单地板比例（规则A，2.2.1）：aged 散文 ≥ max(proseMin, 此比例×W_eff) 才起扫荡单
 *  ——存在性判据，非释放量预测（扫荡 span 整吞远超 aged）。 */
export declare const DEFAULT_AGED_FLOOR_RATIO = 0.05;
/** 份额闸 θ（2.2.1，固化不进设置）：工具面/C ≥ θ ⇒ 摘要通道本轮关闭（剪扛杠杆）。 */
export declare const DEFAULT_TOOLFACE_SHARE_THETA = 0.5;
/** host 形态的固定面余量：tools 声明 + 消息框架 + 分词误差，按 W_eff 的 2% 预留。 */
export declare const SEND_FACE_MARGIN_RATIO = 0.02;
export declare const DEFAULT_INSTRUCTION_TOKENS = 512;
export declare const DEFAULT_MIN_SUMMARY_OUT_TOKENS = 1024;
/** §F churn 保护地板：prune-only 连发且净释放 < max(此值, ratio×W_eff) 视为贴保护线的
 *  空转（g2 实锤：26-29K 同一面上 11 连发、bill 416K），抑制本轮组剪（dedup 照发）。
 *  有状态判定在发射侧（argp-engine），纯函数只持有口径常量。 */
export declare const CHURN_MIN_RELEASE_TOKENS = 1536;
export declare const CHURN_RELEASE_FLOOR_RATIO = 0.05;
/**
 * 决策序（定稿）：
 *  0. C ≤ R：无需压缩。
 *  1. F > W_eff：剪到头仍超真实上限 → terminal-b6（持续性 N 轮/不空转由调用方
 *     带状态处理，纯函数无状态只报形态）。
 *  2. F ≤ R：剪是唯一且够用的杠杆 → 仅剪（α 余量不足只进 reason，不改形态——
 *     摘要判据① F>R 不成立，多一次 miss 没有对象可摘）。
 *  3. F > R：缺口先过地板 max(proseMin, ρ·W_eff)——保留位是软目标，几个 K 的超调
 *     下一轮再剪即可（轮2 工具域实锤：gap 169~4894 全被旧判据放行去摘，血亏）；
 *     过得了地板再判②③：**老化（span 可驱逐口径）散文 ≥ 开单地板
 *     max(proseMin, 5%·W_eff)**——扫荡开单判据=存在性，不是释放量预测（2.2.1 规则A）；
 *     不过 → 仅剪到下限求生（B-6 良性/焦点域/barrier 断供：残余摘不掉）。
 *  3.5 份额闸：工具面（toolCallA+rPair）/C ≥ θ(0.5) → 仅剪（剪扛杠杆，摘要等
 *     主导权交替；饥饿侧由序 3 前提 F>R 结构保证，纯工具稳态循环归观察哨）。
 *  4. 摘要值得做：发送判据按 **host 形态的请求体**（surface 头到 span 末的路由消息 +
 *     tools + 指令，规模上界 = C）：C + 指令 + 2%·W_eff 面余量 ≤ W_eff − 输出地板(1024)
 *     即「摘得出去」（输出预算不足时按剩余空间收缩，§B-2 落地）→ 先摘后剪（有可剪面）/
 *     仅摘（无）。
 *  5. host prompt 贴窗、留不出像样输出 → 不摘，仅剪求生；下一轮新前缀热起来再判。
 */
export declare function planForm(s: DispatchSnapshot): DispatchDecision;
/**
 * §B 分派模式（ARGP_FACTOR_DISPATCH）：
 *  - 未设/其它 ⇒ **'takeover'（2.2.0 裁定：缺省即接管）**——按形态事务（结构去重 →
 *    三形态发射；散文双闸主权移交判据表）。三域实机验收 + 混合世界反例（exclude
 *    分类器必须与接管同进退）背书；
 *  - '0' ⇒ 'off'：显式退回旧双闸世界（逃生口；配 legacy 对照评测/故障回退）；
 *  - '1' ⇒ 'shadow'：只记录决策（日志+文件 sink），不改变发射（用户自发诊断/回归取证）。
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
