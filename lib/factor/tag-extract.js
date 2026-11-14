/**
 * R 贴标器（design-2.0 §2.2）：args 键值通道为主（P0 实测：file 族 document 覆盖 ≈100%），
 * 文本侧仅在 args 通道为空时兜底（增量口径）。纯函数——resultText 由引擎经
 * `rawEventText` 注入（嵌套 tool-result content 的展开是引擎侧职责，P0 坑账第 2 条）。
 */
import { canonicalArgsFp, canonicalPath, labelAllowed } from "./tag-canonical.js";
// ---------------------------------------------------------------------------
// 工具分族（P0 实测名单，逐工具账；G1 定稿口径 = 按族分列）
// ---------------------------------------------------------------------------
export const GREP_TOOLS = new Set(['grep', 'glob', 'search', 'rg', 'list_dir', 'ls']);
export const WRITE_TOOLS = new Set(['write', 'edit', 'multi_edit', 'delete', 'patch', 'apply_patch', 'notebook_edit']);
export const READ_TOOLS = new Set(['read', 'view']);
export const COMMAND_TOOLS = new Set(['bash', 'shell', 'terminal', 'exec', 'run_command', 'run', 'pwsh', 'powershell', 'cmd']);
/**
 * command-medium 白名单（§2.5 v1.1：焦点命令**只参与排序，永不进 hard**；
 * family=首 token 太粗——实测 cd 族保留面爆（语料 36 档 72 枚/81KB）、
 * PowerShell `$env:…` 伪家族剥不掉，故族名必须白名单准入）。
 * 准入=语料高频 dev-execution 族（2026-11-11 实测 36 档：node 987 枚、git 257、
 * npm 43、python 43、pip 43；grep 173 为检索载体不入表）；导航/翻文件族不入——
 * cd 族爆炸半径已定谳，cat/sed/ls 里"命令"只是载体。增删本表须由 T-2 medium 面占比闸复测背书。
 */
export const COMMAND_MEDIUM_FAMILY_WHITELIST = new Set([
    'node', 'git', 'npm', 'python', 'pip',
]);
const FILE_KEYS = ['file_path', 'notebook_path', 'target_file', 'path', 'destination', 'new_path', 'old_path'];
const SCOPE_KEYS = ['path', 'paths', 'dir', 'cwd', 'directory'];
/** ALL_CAPS 错误码的通用噪音词（不配当标签；errorish 标志照举）。 */
const ALLCAPS_STOP = new Set(['ERROR', 'WARNING', 'SUCCESS', 'NOTICE', 'TRACEBACK', 'EXCEPTION', 'PANIC', 'FAILED', 'TODO', 'FIXME', 'FALSE', 'NULL', 'TRUE', 'DEBUG', 'INFO']);
// ---------------------------------------------------------------------------
// 提取正则（文本侧兜底 + 错误信号）
// ---------------------------------------------------------------------------
const ALLCAPS_RE = /\b[A-Z][A-Z0-9_]{4,}\b/g;
const EXITCODE_RE = /\bexit(?:ed)?\s+(?:with\s+)?(?:code|status)\s+(-?\d+)/gi;
const STATUS_RE = /\bstatus\s*[:=]\s*(-?\d+)\b/gi;
const ERR_HINT_RE = /\b(error|err!|failed|failure|fatal|exception|traceback|panic|denied|refused|unresolved)\b/i;
const WIN_PATH_RE = /[A-Za-z]:[\\/][^\s'"`,;)\]{}]+/g;
const UNIX_PATH_RE = /(?:[\w.@-]+\/)+[\w.@-]+\.\w{1,8}/g;
function parseArgsObj(raw) {
    if (typeof raw === 'string') {
        const t = raw.trim();
        if (!t.startsWith('{'))
            return null;
        try {
            const o = JSON.parse(t);
            return typeof o === 'object' && o !== null ? o : null;
        }
        catch {
            return null;
        }
    }
    if (typeof raw === 'object' && raw !== null)
        return raw;
    return null;
}
function strOf(o, key) {
    const v = o[key];
    return typeof v === 'string' && v.trim().length > 0 ? v : null;
}
function strArray(o, key) {
    const v = o[key];
    if (typeof v === 'string')
        return [v];
    if (Array.isArray(v))
        return v.filter((x) => typeof x === 'string');
    return [];
}
function collect(into, raws, cwd, rejects, cap) {
    for (const r of raws) {
        if (into.size >= cap)
            return;
        const cp = canonicalPath(r, cwd);
        if (cp === null)
            continue;
        const rej = labelAllowed(cp.key);
        if (rej !== null) {
            rejects[rej] = (rejects[rej] ?? 0) + 1;
            continue;
        }
        into.add(cp.key);
    }
}
/** bash 命令行 → 命令族（剥 `cd X &&` 前缀/环境赋值/sudo；多行取首行）。 */
export function commandFamily(cmd) {
    let s = cmd.split('\n')[0] ?? '';
    let cwdHint = null;
    const cd = /^cd\s+([^&|;]+)&&?\s*/.exec(s);
    if (cd !== null) {
        cwdHint = cd[1]?.trim() ?? null;
        s = s.slice(cd[0].length);
    }
    s = s.replace(/^(?:sudo\s+|[\w.]+=\S+\s+)*/, '');
    const first = s.trim().split(/\s+/)[0] ?? '';
    if (first.length === 0)
        return { family: null, cwdHint };
    return { family: first.split('/').pop() ?? first, cwdHint };
}
/** read 类 args → 读取范围（staleness 覆盖证明原料；全量读 = offset/limit 均 null）。 */
function readRangeOf(args) {
    const num = (v) => typeof v === 'number' && Number.isFinite(v) ? v : null;
    const offset = num(args['offset']) ?? num(args['start_line']);
    // limit/count 是"条数"；end_line 是**闭区间末行号**——二者不能混当 limit，否则
    // {start_line:10,end_line:20} 被读成 [10,30)，后续 10-20 读会误判覆盖了 10-25 旧读。
    const limit = num(args['limit']) ?? num(args['count']);
    if (limit !== null) {
        if (offset === null)
            return { offset: null, limit };
        return { offset, limit };
    }
    const end = num(args['end_line']);
    if (end !== null) {
        const start = offset ?? 0;
        return { offset: start, limit: Math.max(1, end - start + 1) };
    }
    return offset === null ? null : { offset, limit: null };
}
/**
 * 对一个 R 贴标。通道纪律（§2.2）：
 *  - 命令族：command 标签 + cwd/dir 作用域（args.cwd/dir 是事件时环境的第二来源）；
 *  - grep 族：path/paths 进 scope（目录语义），不进 document；
 *  - file 族/未知工具：FILE_KEYS 逐个试（值须含 `/ : . \`之一，防 grep pattern 混入）；
 *  - 文本侧兜底**仅在 args 通道空**时启用（增量口径，P0 实测覆盖率按 args 通道计）。
 */
export function extractTags(input) {
    const args = parseArgsObj(input.rawArgs);
    const rejects = {};
    const files = new Set();
    const scopes = new Set();
    const commands = new Set();
    const codes = new Set();
    const tool = input.tool;
    let cwd = input.sessionCwd;
    let cwdSeen = false;
    if (args !== null) {
        const cwdArg = strOf(args, 'cwd') ?? strOf(args, 'dir');
        if (cwdArg !== null) {
            cwdSeen = true;
            const cp = canonicalPath(cwdArg, input.sessionCwd);
            if (cp !== null)
                cwd = cp.key;
        }
        if (COMMAND_TOOLS.has(tool)) {
            const cmd = strOf(args, 'command') ?? strOf(args, 'cmd');
            if (cmd !== null) {
                const fam = commandFamily(cmd);
                if (fam.family !== null) {
                    const label = 'command:' + fam.family;
                    const rej = labelAllowed(label);
                    if (rej === null)
                        commands.add(label);
                    else
                        rejects[rej] = (rejects[rej] ?? 0) + 1;
                }
                if (fam.cwdHint !== null)
                    collect(scopes, [fam.cwdHint], cwd, rejects, 4);
            }
        }
        else if (GREP_TOOLS.has(tool)) {
            const scopeRaws = [];
            for (const k of SCOPE_KEYS)
                scopeRaws.push(...strArray(args, k));
            collect(scopes, scopeRaws, cwd, rejects, 8);
        }
        else {
            // 不像路径的原始值先丢（防 grep pattern / 裸词混入）——必须在 canonical 绑 cwd 前判，
            // 绑完 cwd 的键必含 '/'，事后过滤形同虚设（契约测试抓到的首轮病灶）
            const fileRaws = [];
            for (const k of FILE_KEYS)
                fileRaws.push(...strArray(args, k));
            collect(files, fileRaws.filter(r => /[/.:\\]/.test(r.trim())), cwd, rejects, 8);
        }
    }
    if (files.size === 0 && scopes.size === 0) {
        const textRaws = [
            ...(input.resultText.match(WIN_PATH_RE) ?? []),
            ...(input.resultText.match(UNIX_PATH_RE) ?? []),
        ];
        collect(files, textRaws, cwd, rejects, 24);
    }
    let errorish = input.isError === true;
    for (const m of input.resultText.matchAll(EXITCODE_RE)) {
        if (m[1] !== undefined && m[1] !== '0') {
            errorish = true;
            codes.add('exit:' + m[1]);
        }
    }
    for (const m of input.resultText.matchAll(STATUS_RE)) {
        if (m[1] !== undefined && m[1] !== '0') {
            codes.add('status:' + m[1]);
            errorish = true;
        }
    }
    if (!errorish && ERR_HINT_RE.test(input.resultText))
        errorish = true;
    // ALL_CAPS 是**条件挂码**（I-DIR 反例实锤：正常输出 'OLD CONTENT' 的 CONTENT
    // 也是 5+ 大写词）：errorish 必须由 isError/exit≠0/status/错误词独立成立，
    // ALLCAPS 只在成立时挂候选码——禁止 codes 自举 errorish（codes→errorish→codes
    // 的自证循环会批量伪造 sticky 轨，把可剪面杀光）。
    if (errorish) {
        for (const m of input.resultText.matchAll(ALLCAPS_RE)) {
            const c = m[0] ?? '';
            if (!ALLCAPS_STOP.has(c))
                codes.add(c);
        }
    }
    return {
        tool,
        files: [...files],
        scopes: [...scopes],
        commands: [...commands],
        errorcodes: [...codes].slice(0, 16),
        errorish,
        failed: input.isError === true,
        writeish: WRITE_TOOLS.has(tool),
        cwdSeen,
        argsFp: canonicalArgsFp(input.rawArgs),
        readRange: READ_TOOLS.has(tool) && args !== null ? readRangeOf(args) : null,
        sizeChars: input.resultText.length,
        rejects,
    };
}
