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
export const DEFAULT_SUPPLY_MARGIN = 1.2;
export const DEFAULT_PROSE_MIN_TOKENS = 1536;
/** ①缺口地板：F−R 低于 max(proseMin, ρ·W_eff) = 保留位可容忍超调，摘要不值一次 miss。 */
export const DEFAULT_GAP_FLOOR_RATIO = 0.2;
/** ②开单地板比例（规则A，2.2.1）：aged 散文 ≥ max(proseMin, 此比例×W_eff) 才起扫荡单
 *  ——存在性判据，非释放量预测（扫荡 span 整吞远超 aged）。 */
export const DEFAULT_AGED_FLOOR_RATIO = 0.05;
/** 份额闸 θ（2.2.1，固化不进设置）：工具面/C ≥ θ ⇒ 摘要通道本轮关闭（剪扛杠杆）。 */
export const DEFAULT_TOOLFACE_SHARE_THETA = 0.5;
/** host 形态的固定面余量：tools 声明 + 消息框架 + 分词误差，按 W_eff 的 2% 预留。 */
export const SEND_FACE_MARGIN_RATIO = 0.02;
export const DEFAULT_INSTRUCTION_TOKENS = 512;
export const DEFAULT_MIN_SUMMARY_OUT_TOKENS = 1024;
/** §F churn 保护地板：prune-only 连发且净释放 < max(此值, ratio×W_eff) 视为贴保护线的
 *  空转（g2 实锤：26-29K 同一面上 11 连发、bill 416K），抑制本轮组剪（dedup 照发）。
 *  有状态判定在发射侧（argp-engine），纯函数只持有口径常量。 */
export const CHURN_MIN_RELEASE_TOKENS = 1536;
export const CHURN_RELEASE_FLOOR_RATIO = 0.05;
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
export function planForm(s) {
    const alpha = s.supplyMargin ?? DEFAULT_SUPPLY_MARGIN;
    const proseMin = s.proseMinTokens ?? DEFAULT_PROSE_MIN_TOKENS;
    const deficit = s.contextTokens - s.retainTokens;
    if (deficit <= 0 && s.trigger !== 'context-overflow') {
        return { form: 'none', reason: `C ${s.contextTokens} ≤ R ${s.retainTokens}：无需压缩` };
    }
    if (s.floorTokens > s.windowEff) {
        return { form: 'terminal-b6', reason: `下限 ${s.floorTokens} > W_eff ${s.windowEff}：剪到头也放不下（不可剪残余超物理窗）` };
    }
    if (s.floorTokens <= s.retainTokens) {
        const marginOk = s.prunableTokens >= Math.ceil(alpha * deficit);
        return {
            form: 'prune-only',
            reason: marginOk
                ? `F ${s.floorTokens} ≤ R ${s.retainTokens} 且供给 ${s.prunableTokens} ≥ ${alpha}×D：仅剪`
                : `F ≤ R 但供给 ${s.prunableTokens} < ${alpha}×D：仅剪（弱余量，摘要判据①不成立，残差下轮再收）`,
        };
    }
    const gap = s.floorTokens - s.retainTokens;
    const gapFloor = Math.max(proseMin, (s.gapFloorRatio ?? DEFAULT_GAP_FLOOR_RATIO) * s.windowEff);
    if (gap <= gapFloor) {
        return {
            form: 'prune-only',
            reason: `F ${s.floorTokens} 高出 R ${gap} ≤ 地板 ${Math.floor(gapFloor)}（max(proseMin, ρ·W_eff)）：保留位软目标，仅剪可容忍超调，摘要不值一次 miss`,
        };
    }
    // 判据②③（规则A，2.2.1 包一）：供给口径=三桶 **aged**（缺省回退 total=口径输入回退，
    // 本判据对旧快照照常生效）；开单判据=**存在性地板** max(proseMin, 5%·W_eff)，不再是「散文补得上缺口」
    // 的释放量预测——扫荡式摘要 span 整吞远超 aged（T36 aged 38K 实吞 115K），缺口口径
    // 系统性低估合形释放、把 T42 型负载推成浅剪连发（46 轮账本 + 反事实回放实锤）。
    // barrier 断供/散点/焦点面在 aged 口径下不计供给（v1 年龄公式的虚高形态已由 run
    // 分组构造封死，见 prose-condenser.scanProseBuckets）。
    const aged = s.condensableProseAgedTokens ?? s.condensableProseTokens;
    const agedFloor = Math.max(proseMin, DEFAULT_AGED_FLOOR_RATIO * s.windowEff);
    if (aged < agedFloor) {
        return {
            form: 'prune-only',
            reason: `F ${s.floorTokens} > R 但老化可浓缩散文 ${aged} < 开单地板 ${Math.floor(agedFloor)}（max(proseMin, 5%·W_eff)）：焦点/barrier 面不算供给，不摘要`,
        };
    }
    // 份额闸（2.2.1 包一，θ=0.5 固化）：工具面（toolCallA+rPair，附件 R 落 barrier 低估
    // ⇒ 方向安全）仍占当前上下文 ≥θ ⇒ 剪扛杠杆、摘要等主导权交替。饥饿不属本闸：
    // 能走到这里必须已过序 3 前提 F > R（剪必不达 R）；工具份额稳态 ≥θ 的纯工具循环
    // 摘要通道设计性关闭，归观察哨管辖（design-2.2.x §1.3/§2）。
    const toolShare = s.contextTokens > 0 ? (s.toolFaceTokens ?? 0) / s.contextTokens : 0;
    if (toolShare >= DEFAULT_TOOLFACE_SHARE_THETA) {
        return {
            form: 'prune-only',
            reason: `工具面仍主导 ${(toolShare * 100).toFixed(1)}% ≥ θ ${DEFAULT_TOOLFACE_SHARE_THETA}：剪扛杠杆，摘要等主导权交替`,
        };
    }
    // 发送可行性按 **host 形态的请求体**判（2.3.0 起唯一发射形态）：摘要请求回放
    // surface 头到 span 末的全部路由消息 + tools 声明 + 尾部指令。其规模上界就是当前
    // 上下文 C（含焦点/开轮尾部与未提交输入——实际 span 末更短，判据因此偏保守）。
    // 旧口径只算可浓缩散文 transcript（legacy A 形态），会把输出预算高估到越界（B2）。
    const instruction = s.instructionTokens ?? DEFAULT_INSTRUCTION_TOKENS;
    const minOut = s.minSummaryOutTokens ?? DEFAULT_MIN_SUMMARY_OUT_TOKENS;
    const faceMargin = Math.round(s.windowEff * SEND_FACE_MARGIN_RATIO);
    const sendPrompt = s.contextTokens;
    const roomForOutput = s.windowEff - sendPrompt - instruction - faceMargin;
    if (roomForOutput >= minOut) {
        const shrunk = roomForOutput < s.summarySendTokens - instruction;
        const budget = `host prompt ≤ ${sendPrompt}+指令 ${instruction}+面余量 ${faceMargin}（输出预算 ${roomForOutput}${shrunk ? ' < 标准 ' + (s.summarySendTokens - instruction) + '→收缩' : ''}）`;
        return s.prunableTokens > 0
            ? { form: 'summarize-then-prune', outBudget: roomForOutput, reason: `${budget}：先摘后剪（摘后复测仍有 deficit 才补剪）` }
            : { form: 'summarize-only', outBudget: roomForOutput, reason: `${budget}且无可剪供给：仅摘` };
    }
    return {
        form: 'prune-only',
        reason: `host prompt ≤ ${sendPrompt}+指令 ${instruction}+面余量 ${faceMargin} 顶到 W_eff ${s.windowEff}（输出仅剩 ${roomForOutput} < ${minOut} 地板）：热前缀装不下摘要，仅剪求生（下轮新前缀热起来再摘）`,
    };
}
export function resolveDispatchMode(env = process.env) {
    const v = env['ARGP_FACTOR_DISPATCH'];
    if (v === '0')
        return 'off';
    if (v === '1')
        return 'shadow';
    return 'takeover';
}
/** 影子分派日志开关（ARGP_FACTOR_DISPATCH=1/2 都记录）：shadow 模式只记录不改发射。 */
export function resolveDispatchShadowEnabled(env = process.env) {
    return resolveDispatchMode(env) !== 'off';
}
/**
 * 影子决策落盘路径（ARGP_FACTOR_DISPATCH_LOG）：DSH CLI 的 logger 不进 harness 的
 * stdout/stderr 采集面，实机三域对照必须走文件 sink（§D 影子同口径）。未设 ⇒
 * 仅走 this.log（开发环境肉眼可见），不落盘。
 */
export function resolveDispatchShadowLogPath(env = process.env) {
    const p = env['ARGP_FACTOR_DISPATCH_LOG'];
    return p !== undefined && p !== '' ? p : undefined;
}
