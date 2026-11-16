/**
 * 交互类工具：名单、检查点专段文案、Q/A 预览提取（design-tool-facet-2026-11-16）。
 *
 * 用户裁定（2026-11-16 两轮）：
 * ① 交互工具照常参与剪枝（排序学不动、HardFlags 不加位）——补的是**展示面**：
 *    词表置顶 + Q/A 部分字符预览；
 * ② 名单只管制**预览展示**，不管制 tool 键入键（tool:<name> 全量入键，见 indexKeys）。
 *
 * 名单口径（P5 实锤）：`ask_user_question`/`exit_plan_mode` 是宿主硬编注册名；
 * `subagent`/`subagent_fork` 是 **preset config `toolName` 的缺省值**（tool-subagent
 * index.ts:49）——用户改配置 ⇒ 预览静默降级为名-only 行、键照入（ZT11 锁：名单外
 * 永不产预览）。扩容前置（A4 裁定）：名单兼管置顶+预览，"要预览不要置顶"的候选
 * （如 job_output）须先把名单拆成 preview-list / pin-list 两列才可准入。
 *
 * 形状即门槛（审查 P2 [未验-疑] 伪装名对策）：提取器按宿主 schema 逐形解析，
 * args/R 形状不符 ⇒ 该侧置空/整体 null——注册名撞车不构成预览利用面。
 *
 * 预览 = 新注入面：每侧 ≤80 chars、压平控制符、逐侧过 labelAllowed（secret 拒收）。
 * 在线与重建**共用本文件**（canonical 单点纪律，同 tag-canonical 教训）：
 * tagRsFromLog 是唯一提取点，ZT6 锁在线/重建逐字节一致。
 */
import { parseArgsObj } from './tag-extract.ts'
import { labelAllowed } from './tag-canonical.ts'

export const INTERACTIVE_PREVIEW_TOOLS: ReadonlySet<string> = new Set([
  'ask_user_question', 'exit_plan_mode', 'subagent', 'subagent_fork',
])

/** 检查点专段的成员描述（按在场成员措辞，ZT10：不得含组内不存在的承诺）。 */
const INTERACTIVE_SHORT_LABEL: Readonly<Record<string, string>> = {
  ask_user_question: '用户问答',
  exit_plan_mode: '计划审批',
  subagent: '子代理启动',
  subagent_fork: '子代理启动',
}

/** tool 键 → 是否交互族（renderVocabulary 谓词注入用；名单知识不进 factor-ledger）。 */
export function isInteractiveToolKey(key: string): boolean {
  return key.startsWith('tool:') && INTERACTIVE_PREVIEW_TOOLS.has(key.slice('tool:'.length))
}

/**
 * 交互组检查点专段（P7=带：组剪当刻给即时召回指针，近因强于词表 note 常驻指针）。
 * 破组剪「检查点零指针」常规**仅限交互组**；普通组仍 FACTOR_COMPACTED_MARKER。
 * 措辞只提在场成员（ZT7/ZT10）；subagent 不得暗示可取回报告——R 恒为启动回执，
 * 报告是 U notice 从不被 factor 剪（P0-2 实锤）。
 */
export function interactiveCheckpointText(tools: readonly string[]): string {
  const uniq: string[] = []
  for (const t of tools) if (INTERACTIVE_PREVIEW_TOOLS.has(t) && !uniq.includes(t)) uniq.push(t)
  const shown = uniq.slice(0, 3).map(t => INTERACTIVE_SHORT_LABEL[t] ?? t).join('、')
  const more = uniq.length > 3 ? ' 等' : ''
  const keys = uniq.slice(0, 3).map(t => 'tool:' + t).join(' / ')
  return `已压缩交互记录（${shown}${more}），recall_history(${keys}) 可取回原文`
}

// ---------------------------------------------------------------------------
// Q/A 预览提取（形状门槛 + 注入面收缩）
// ---------------------------------------------------------------------------

export interface PreviewBits {
  /** Q 侧（来自配对 A 的 args，交互内容摘要）。 */
  q?: string
  /** A 侧（来自 R 原文；subagent 恒缺——R 无信息量）。 */
  a?: string
  /** 多问标记（ask_user_question questions>1）：预览只装得下首问，q×n 防漏答误导。 */
  qCount?: number
}

const PREVIEW_SIDE_CAP = 80

/** 压平：控制符→单空格、折叠连续空格、trim（词表行是单行 prompt 面）。 */
function flatten(s: string): string {
  return s.replace(/[\r\n\t\x00-\x1f]+/g, ' ').replace(/ {2,}/g, ' ').trim()
}

/** 预览侧收缩：flatten → 80 截断 → labelAllowed（secret/异常形态 ⇒ 该侧弃）。 */
function shrinkSide(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const f = flatten(raw)
  if (f === '') return undefined
  const capped = f.length > PREVIEW_SIDE_CAP ? f.slice(0, PREVIEW_SIDE_CAP - 1) + '…' : f
  return labelAllowed(capped) === null ? capped : undefined
}

function firstLine(s: string): string {
  const i = s.indexOf('\n')
  return i < 0 ? s : s.slice(0, i)
}

/** answers[] 拼可读形：`id=选1/选2（custom）; …`（schema 封闭 additionalProperties:false）。 */
function answersText(resultText: string): string | undefined {
  const o = parseArgsObj(resultText)
  const answers = o !== null && Array.isArray(o['answers']) ? (o['answers'] as unknown[]) : null
  if (answers === null || answers.length === 0) return undefined
  const parts: string[] = []
  for (const raw of answers) {
    if (raw === null || typeof raw !== 'object') continue
    const a = raw as { id?: unknown; selected?: unknown; custom?: unknown }
    const selected = Array.isArray(a.selected) ? a.selected.filter((x): x is string => typeof x === 'string') : []
    const body = a.custom !== undefined && typeof a.custom === 'string' && a.custom.trim() !== ''
      ? `${selected.join('/')}（${flatten(a.custom)}）`
      : selected.join('/')
    if (body !== '') parts.push(typeof a.id === 'string' && a.id !== '' ? `${a.id}=${body}` : body)
  }
  return parts.length > 0 ? parts.join('; ') : undefined
}

/**
 * 按注册名分派的形状门槛提取器。返回 null = 名-only 行（形状不符/两侧皆弃）；
 * 调用方（tagRsFromLog）只对名单内工具调用——名单外恒无预览（ZT11）。
 */
export function extractPreview(tool: string, rawArgs: unknown, resultText: string): PreviewBits | null {
  if (!INTERACTIVE_PREVIEW_TOOLS.has(tool)) return null
  const args = parseArgsObj(rawArgs)
  let bits: PreviewBits | null = null
  if (tool === 'ask_user_question') {
    const questions = args !== null && Array.isArray(args['questions']) ? (args['questions'] as unknown[]) : null
    if (questions !== null && questions.length > 0) {
      const qs: string[] = []
      for (const item of questions) {
        const q = item !== null && typeof item === 'object' ? (item as { question?: unknown }).question : undefined
        if (typeof q === 'string' && flatten(q) !== '') qs.push(flatten(q))
      }
      if (qs.length > 0) bits = { q: qs.join(' / '), ...(qs.length > 1 ? { qCount: qs.length } : {}) }
    }
    // A 侧禁裸取 R 首段（= JSON 骨架，P1-4），必须按 output schema 解析 answers。
    const a = shrinkSide(answersText(resultText))
    if (a !== undefined) bits = { ...(bits ?? {}), a }
  } else if (tool === 'exit_plan_mode') {
    const plan = args !== null && typeof args['plan'] === 'string' ? args['plan'] : undefined
    // 首行 = 强制 `# 标题`（plan-mode :307 校验）——目录级信息量，够"认出是哪次审批"。
    const q = plan !== undefined ? shrinkSide(firstLine(plan).replace(/^#+\s*/, '')) : undefined
    const a = shrinkSide(firstLine(resultText))
    bits = { ...(q !== undefined ? { q } : {}), ...(a !== undefined ? { a } : {}) }
  } else {
    // subagent/subagent_fork：Q=args.prompt 首段；A 侧**恒缺**——R 恒 `started subagent
    // <name>`（P0-2），报告走 U notice 不被剪，预览/文案不得暗示可取回报告。
    const prompt = args !== null && typeof args['prompt'] === 'string' ? args['prompt'] : undefined
    const q = prompt !== undefined ? shrinkSide(firstLine(prompt)) : undefined
    bits = q !== undefined ? { q } : null
  }
  if (bits === null) return null
  const q = shrinkSide(bits.q)
  const a = shrinkSide(bits.a)
  const out: PreviewBits = { ...(q !== undefined ? { q } : {}), ...(a !== undefined ? { a } : {}), ...(bits.qCount !== undefined ? { qCount: bits.qCount } : {}) }
  return out.q === undefined && out.a === undefined ? null : out
}
