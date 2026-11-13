/**
 * ARGP 墓碑文案叶模块——墓碑文本与判据的**单一事实源**。
 *
 * 墓碑文本有 4 个生成点（区间、单节点、闭包、聚合；tool 占位是独立一族）与 3 个消费
 * 判据（`isToolTombstoneText` / `isTombstoneText` / `isMergeableTombstoneText`）。
 * 文案与判据放进同一文件，使二者**物理上不可分离**：任何措辞改动若绕过判据，测试即红
 * （漏改可合并判据 ⇒ tool 占位墓碑被归并 ⇒ callId 蒸发 ⇒ issuer A 的 tool_calls 失去
 * 应答 ⇒ provider 400；漏改终止态谓词 ⇒ "墓碑换墓碑"空转）。
 *
 * ## 零 import（硬约束）
 *
 * `prune-tx` 是 hub 的下游、要 import 本模块；若本模块反向 import 任一运行时模块即成
 * 循环依赖（仓库既有的"单向依赖：hub → X"设计决策）。故本模块**没有任何 import**
 * （含 type-only）。
 *
 * ## 文案形态（统一短文案，带 `for detail` 劝说语）
 *
 * ```
 * [elided seq=A..B; recall_pruned(A) for detail]                  区间
 * [elided seq=A; recall_pruned(A) for detail]                     单节点
 * [elided closure <id> seqs=A..B[; root=<preview>]; recall_pruned(A) for detail]
 * [elided consolidated ×N seqs=A..B; recall_pruned(A) for detail]
 * [elided: seq=A; recall_pruned(A) for detail]                    tool 占位
 * ```
 *
 * 设计要点：
 * 1. **`[elided` 前缀保留**：既有 `startsWith('[elided')` 类判据不破；但判据必须校验
 *    紧随字符（空格/冒号），裸前缀会把用户自造文本误认成墓碑。
 * 2. **"被剪的是什么 / 怎么取回"只在 system 契约里说一次**（`argp-contract` section），
 *    不在每条墓碑重复——单条重复是指引膨胀的结构性根因。
 * 3. **seq 一律是原始节点的 log seq**（不是 replace 副本 seq）：取回指针才是合法入参；
 *    只写 `recall_pruned(seq)` 却不给 seq 会让通路等于断的。
 * 4. **`for detail`** 是劝说语：+11 字符买"召回入口指引"，缺的是入口而非能力。
 *    与之配套：召回上限是**字符预算**（见 `recall.ts` budgetRecallText），不是次数闸。
 *
 * ## 判别子
 *
 * "不可合并 vs 可合并"由**语法级前缀**承担：`[elided:`（冒号）= tool 占位墓碑，
 * `[elided `（空格）= 可合并族。不要用自然语言子串（措辞一改就失效）；前缀是语法级、
 * 不随修辞漂移，且与文案生成同处一文件。
 */
/**
 * 全部 ARGP 墓碑的公共前缀。
 * ⚠️ 判据必须校验**紧随其后的字符**（空格或冒号），否则 `[elidedFoo` 这类
 * 用户自造文本会被误认为墓碑（`startsWith('[elided')` 单独用是不够的）。
 */
export const TOMBSTONE_PREFIX = '[elided';
/** tool 占位墓碑前缀（冒号形态）——`isMergeableTombstoneText` 的"不可合并"判别子。 */
export const TOOL_TOMBSTONE_PREFIX = '[elided:';
/**
 * 墓碑长度安全阀（G1 终止态排除的例外上限）。
 *
 * G1 把"文本已是墓碑"当作**终止态**（再剪一次仍产出墓碑 = 收益 0，实测占全部 replace
 * 的 76.2%）。但极长墓碑若被一律排除会**卡住地板**：长度是"还有东西可丢"的弱信号，
 * 超长说明它本身承载可观字符（闭包墓碑曾内联整行 rootPreview，无上限）。
 * ⇒ 超过本阈值的墓碑仍允许参剪（宁少剪，不卡地板；少剪是安全方向）。
 */
export const TOMBSTONE_MAX_CHARS = 200;
/**
 * 闭包墓碑里 root 预览的截断长度。
 *
 * 不截断时 root 预览可整行内联 ⇒ 单条闭包墓碑可达数千字符，既抬地板又让 G1 的长度
 * 安全阀失效。截断后闭包墓碑回到百字符内。
 */
export const CLOSURE_ROOT_PREVIEW_MAX_CHARS = 40;
/** 取回指引后缀（用户拍板带劝说语）。 */
const RETRIEVE_HINT = ' for detail';
/** 用户文本里的换行/制表会破坏单行墓碑形态；预览在生成期折叠为单空格。 */
function previewText(raw) {
    const oneLine = raw.replace(/\s+/g, ' ').trim();
    return oneLine.length <= CLOSURE_ROOT_PREVIEW_MAX_CHARS
        ? oneLine
        : oneLine.slice(0, CLOSURE_ROOT_PREVIEW_MAX_CHARS) + '…';
}
/** `[elided` 且紧随空格或冒号 ⇒ 确认为 ARGP 墓碑（排除 `[elidedFoo` 类误判）。 */
function hasTombstonePrefix(t) {
    if (!t.startsWith(TOMBSTONE_PREFIX))
        return false;
    const next = t.charAt(TOMBSTONE_PREFIX.length);
    return next === ' ' || next === ':';
}
/** `seq=A..B` 片段（`A === B` 时省略 `..B`，单节点形态）。 */
function seqSpan(start, end) {
    return 'seq=' + start + (end === start ? '' : '..' + end);
}
/** `seqs=A..B` 片段（闭包/聚合族用复数，因为它们是"多段墓碑归并"的产物）。 */
function seqsSpan(start, end) {
    return 'seqs=' + start + (end === start ? '' : '..' + end);
}
/** 取回指引（`recall_pruned(<seq>) for detail`）。 */
function retrieve(seq) {
    return 'recall_pruned(' + seq + ')' + RETRIEVE_HINT;
}
// ---------------------------------------------------------------------------
// 生成器（唯一文案出口）
// ---------------------------------------------------------------------------
/**
 * tool 占位墓碑（剪 R 而保留 issuer A 时使用）。
 *
 * 保留 `callId` 配对是**协议硬要求**（`assertToolResultRewrite` 只允许改 inner text），
 * 故文案本身不改结构，只补 seq —— issuer A 的 tool-call 就在紧邻位置（实测 346/364
 * 距离 ≤ 2），模型据此即可判断"这是哪次调用"，缺的只是**取回指针**。
 */
export function toolTombstone(originalSeq) {
    return TOOL_TOMBSTONE_PREFIX + ' seq=' + originalSeq + '; ' + retrieve(originalSeq) + ']';
}
/** 单节点/区间 user 墓碑（`start === end` 时退化为单节点形态）。 */
export function seqRangeTombstone(start, end) {
    return TOMBSTONE_PREFIX + ' ' + seqSpan(start, end) + '; ' + retrieve(start) + ']';
}
/** 闭包墓碑（整段闭包生命周期退休）。`rootPreview` 为空串时省略 root 片段。 */
export function closureTombstone(closureId, start, end, rootPreview) {
    const root = previewText(rootPreview);
    return TOMBSTONE_PREFIX + ' closure ' + closureId + ' ' + seqsSpan(start, end)
        + (root === '' ? '' : '; root=' + root) + '; ' + retrieve(start) + ']';
}
/** 聚合墓碑（tombstone-merge：多条墓碑归并为一条）。 */
export function consolidatedTombstone(count, start, end) {
    return TOMBSTONE_PREFIX + ' consolidated ×' + count + ' ' + seqsSpan(start, end)
        + '; ' + retrieve(start) + ']';
}
/**
 * factor 臂中断轮半截 A 的 user 墓碑（P6-③ 裁定 3）。不引 `recall_pruned`——factor 臂
 * 无该通道（假通道纪律同 factor 桩"禁引退役工具名"）；原文在 append-only 日志按 seq 检索。
 * 非可并族（无 recall_pruned 指引）——罕见的协议残渣节点，不值得为它们扩可并文法。
 */
export function factorAssistantTombstone(seq) {
    return TOMBSTONE_PREFIX + ' seq=' + seq + '; 原文在 append-only 日志]';
}
/**
 * `CompactionResult.summary` 里的 tool 墓碑渲染文本。
 *
 * 不进 prompt（`compaction/summary` 是 off-surface 日志事件，UI 展示用），故不带 seq
 * ——summary 是轮级汇总，写出某个具体 seq 会误导。
 */
export function toolTombstoneSummary() {
    return TOOL_TOMBSTONE_PREFIX + ' tool result compressed]';
}
// ---------------------------------------------------------------------------
// 判据（唯一识别出口）
// ---------------------------------------------------------------------------
/** 是否为 tool 占位墓碑文本（`[elided:` 冒号族）。 */
export function isToolTombstoneText(text) {
    return text.trimStart().startsWith(TOOL_TOMBSTONE_PREFIX);
}
/**
 * 结构锚定文法（1.10.2，0-3）：现行四族 + 已知历史文法（v1.3.x–v1.7.x 存量会话）的**整串**匹配。
 *
 * 病灶：裸前缀 `startsWith('[elided')`（含前缀+紧随字符的宽判据）把"内容长相"当"终止态
 * 判据"——本插件把 `[elided` 写进 system 契约与自身源码，模型引用/工具输出复述前缀即
 * 获得 G1 终止态免剪（零成本制造永生区，Qwen M3 已复现）。整串文法使**意外碰撞**
 * （源码引用、日志转录中截断的墓碑片段）不再命中。
 *
 * ⚠️ 文法锚定挡不住**刻意伪造**（照抄完整文法的 append 事件）——那层由 G1/A10 的
 * **replace 事件锚**（transaction 的 `compaction/prune` 记录）承担：真墓碑只能
 * 由 surfaceOp replace 产生，append 事件永不终止态。文本判据与事件锚**串联**使用。
 */
const TOMBSTONE_GRAMMARS = [
    // 现行四族（tombstone-text.ts 生成器逐字对应）
    /^\[elided: seq=\d+; recall_pruned\(\d+\) for detail\]$/,
    /^\[elided seq=\d+(?:\.\.\d+)?; recall_pruned\(\d+\) for detail\]$/,
    /^\[elided closure closure-\d+ seqs=\d+(?:\.\.\d+)?(?:; root=.*)?; recall_pruned\(\d+\) for detail\]$/,
    /^\[elided consolidated ×\d+ seqs=\d+(?:\.\.\d+)?; recall_pruned\(\d+\) for detail\]$/,
    // off-surface 摘要形态（CompactionResult.summary 渲染，永不进 surface；入表保持"族完整"）
    /^\[elided: tool result compressed\]$/,
    // factor 臂中断轮半截 A（P6-③ 裁定 3；factorAssistantTombstone 逐字对应）
    /^\[elided seq=\d+; 原文在 append-only 日志\]$/,
    // 历史文法（git v1.3.0 / v1.5.0 / v1.7.0 生成器逐字核对；存量会话重放时仍需识别）
    /^\[elided: 旧版本结果已压缩；recall_pruned\(seq\) 找回原值\]$/,
    /^\[elided tool result; recall_pruned\(seq\) retrieves original\]$/,
    /^\[elided seq=\d+\.\.\d+: \d+ surface nodes pruned by ARGP \(graph order, cites-aware(?:, forced)?\); recall_pruned\(seq\) retrieves original\]$/,
    /^\[elided closure closure-\d+ seqs=\d+\.\.\d+: \d+ of \d+ surface nodes in this closure pruned by ARGP closure lifecycle; root=.*; recall_pruned\(seq\) retrieves original\]$/,
    /^\[elided consolidated ×\d+ seqs=\d+\.\.\d+: these placeholder nodes were themselves pruned by ARGP \(tombstone-merge, §11\.8\); originals remain recallable via recall_pruned\(seq\) \/ list_pruned\]$/,
];
/**
 * 是否为 ARGP 墓碑文本（**全部**四族，现行 + 已知历史文法的整串匹配）。
 *
 * G1/A10 的终止态判定 = 文本判据 + replace 事件锚串联
 * 使用本函数；单用文本判据不足以承担终止态语义。peratom 的压缩副本标记
 * （`[已压缩-摘取 seq=N]` / `[已压缩-摘要 seq=N]`）**不算**墓碑 —— 它是 LLM 压缩过的
 * 摘要，仍含信息，应当可继续被剪。
 */
export function isTombstoneText(text) {
    const t = text.trimStart();
    return TOMBSTONE_GRAMMARS.some(re => re.test(t));
}
/**
 * 宽松旧版墓碑判据（**只允许与 replace 事件锚串联使用**）：墓碑前缀 + `recall_pruned(`
 * + ARGP 自我标识（`pruned by ARGP` / `旧版本结果已压缩` / `tombstone-merge`）。
 *
 * 用途：覆盖枚举不到的**历史中间版本**墓碑（1.4–1.6 的闭包/聚合措辞微调过多次）。
 * 它们全部是 replace 事件，事件锚已排除伪造；宽松文本只影响"真墓碑漏认"方向
 * （漏认 ⇒ 空转回归，宁可宽认）。**禁止**脱离事件锚单独使用本判据。
 */
export function isLooseLegacyTombstoneText(text) {
    const t = text.trimStart();
    if (!hasTombstonePrefix(t))
        return false;
    if (!t.includes('recall_pruned('))
        return false;
    return t.includes('pruned by ARGP') || t.includes('旧版本结果已压缩') || t.includes('tombstone-merge');
}
/**
 * 是否为**可合并**墓碑（`consolidateTombstones` 的判据）。
 *
 * 可合并 = ARGP 墓碑（`[elided ` 空格族，排除 tool 占位）+ 含 `recall_pruned(` 取回指引。
 * 两条排除项都是**双保险**性质：
 *  - `consolidateTombstones` 本就只扫 `user/message` 事件（tool 墓碑是 `tool/result`），
 *    故 tool 墓碑到不了这里；前缀判别子防的是"有人把这个纯函数用到别处"。
 *  - 要求 `recall_pruned(` 排除宿主 system-reminder / 官方 checkpoint / 恰好提到
 *    `recall_pruned` 的用户正文（测试用例锁定）。
 */
export function isMergeableTombstoneText(text) {
    const t = text.trimStart();
    if (!hasTombstonePrefix(t))
        return false;
    if (t.startsWith(TOOL_TOMBSTONE_PREFIX))
        return false;
    return t.includes('recall_pruned(');
}
