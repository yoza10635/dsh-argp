/**
 * Preset 净化器（0.1.7 版：patch-composition override）。
 *
 * 背景：0.1.7 起 agent preset 是声明式 patch 行（`- id: preset-<id>`，由
 * `@deepseek-ai/dsh-agent-preset` 插件经 `AgentPresetRegistry.register()` 消费），
 * 不再是 0.1.6 的 `~/.dsh/.agent-presets/` 文件 roster。0.1.7 的 registry
 * **没有 copy/read/变更 API**（`register` 对重复 id 直接抛错），因此 0.1.6 的
 * 「copy 到 user root + 行手术」路径整体失效。
 *
 * 0.1.7 唯一能改 preset 配置的机制＝**patch 组合层按行 id override**：后层
 * patch 写 `- id: preset-<id>` 的 modify 行，last-write-wins 整体替换 `config`
 * （SKILL: editing-cordis-compositions「override replaces the complete config」）。
 * dsh-argp 是 web profile 的**最后一个 bundle**（base → web-app → dsh-argp），
 * 故本包 `cordis.patch.yml` 里的 override 行必然压过 web-app 的 preset insert
 * 声明。
 *
 * 本模块提供**纯文本手术**（不解析、不求值——shipped 文件带 `!!js` 标签，通用
 * YAML 库拒载；整块删列表项不破坏语法）：
 * - {@link stripPresetRows} 整块摘除 stock compaction 行（compaction-basic /
 *   tool-result-pruner）；
 * - {@link stripIsolateBlock} 摘除 compaction 组的 `isolate` 块——剥离 stock
 *   提供者后若保留 isolate，cordis 的 `isolate(name)` 建全新 symbol（入口局部
 *   realm，**不回落到父 realm**），`command-compact` 的 `inject=['commands',
 *   'compaction']` 会在空 realm 里永久 "waiting for compaction"；摘除后组变
 *   普通组，消费端沿 scope 链解析到宿主平面的 `ctx.compaction`＝本插件的
 *   ArgpGraphEngine（extends CompactionEngine，服务名 `compaction`），`/compact`
 *   自动指向 ARGP 的确定性 compactNow，零额外接线；
 * - {@link dropEmptyGroups} 组内清空时连组删除（loader 的 entryListProblem 会
 *   拒「group must hold a list」）；
 * - {@link purifyPresetPatch} 把 shipped preset 的 `- insert:` 声明转成顶层
 *   modify override 行（去缩进 4），供 `scripts/generate-preset-overrides.mjs`
 *   生成 `cordis.patch.yml` 的 override 段。
 *
 * 世代/自愈语义：override 行随包分发（tgz 内 cordis.patch.yml），每次安装/
 * 升级自动落位——这是 0.1.7 的「自愈」形态（对比 0.1.6 需运行时 copy+重清理）。
 * 宿主若更新 shipped preset（增删插件），用生成脚本重跑 override 段即可重新
 * 对齐（override 整体替换 config，不会自动合并宿主后续改动——registry README
 * 明示的已知限制）。
 * @module dsh-argp/preset-cleaner
 */
/** preset 文件里必须摘除的 stock compaction 行（compaction-basic 是双引擎冲突本体）。 */
export const DEFAULT_STRIP_ROWS = ['compaction-basic', 'tool-result-pruner'];
/** 默认要摘除 isolate 块的组 id。 */
export const DEFAULT_ISOLATE_GROUP = 'compaction';
/**
 * 从 preset composition 文本中整块删除指定 `- id: <row>` 列表项。
 *
 * 项块 = 该行 + 后续所有「更深缩进或空行/注释（跟随至下一非空行归属判定）」的行。
 * 只删列表项不碰其他行，语法不可能被破坏；组内清空交给 {@link dropEmptyGroups}。
 * @param source - composition 文本。
 * @param rows - 要摘除的行 id 集合。
 * @returns 净化后文本与实际摘除的 id（顺序 = 文件出现序）。
 */
export function stripPresetRows(source, rows) {
    const lines = source.split('\n');
    const out = [];
    const removed = [];
    let i = 0;
    while (i < lines.length) {
        const match = /^(\s*)- id: (\S+)\s*$/.exec(lines[i]);
        if (match !== null && rows.includes(match[2])) {
            const rowIndent = match[1].length;
            // 扫描项块：空行/注释行先缓存，由下一非空行的缩进决定归属——
            // 更深 = 块内（连同缓存一并丢弃），否则 = 块外（缓存放回）。
            let j = i + 1;
            let pending = [];
            while (j < lines.length) {
                const line = lines[j];
                if (line.trim() === '' || line.trimStart().startsWith('#')) {
                    pending.push(line);
                    j += 1;
                    continue;
                }
                const indent = line.length - line.trimStart().length;
                if (indent > rowIndent) {
                    pending = [];
                    j += 1;
                    continue;
                }
                break;
            }
            removed.push(match[2]);
            out.push(...pending);
            i = j;
            continue;
        }
        out.push(lines[i]);
        i += 1;
    }
    return { text: out.join('\n'), removed };
}
/**
 * 删除 `config:` 列表已被清空的 `group: true` 组块。
 *
 * 行手术可能把组内唯一成员摘净，留下 `config:` 空值——loader 的 entryListProblem
 * 会判「group must hold a list」而拒绝整个 preset，故必须连组删除。
 * @param source - composition 文本。
 * @returns 清理后文本（无空组时原样返回）。
 */
export function dropEmptyGroups(source) {
    const lines = source.split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
        const match = /^(\s*)- id: (\S+)\s*$/.exec(lines[i]);
        let groupEnd = -1;
        if (match !== null) {
            const rowIndent = match[1].length;
            let j = i + 1;
            let pending = [];
            let hasGroupMarker = false;
            let configEmpty = false;
            while (j < lines.length) {
                const line = lines[j];
                if (line.trim() === '' || line.trimStart().startsWith('#')) {
                    pending.push(line);
                    j += 1;
                    continue;
                }
                const indent = line.length - line.trimStart().length;
                if (indent <= rowIndent)
                    break;
                pending = [];
                // group/config 键只认组直接子级（rowIndent+2）：嵌套更深的同名键（如叶子行
                // 的 config map）不是组结构，绝不能触发空组判定（否则误删整组）。
                if (indent === rowIndent + 2 && /^\s*group:\s*true\s*$/.test(line))
                    hasGroupMarker = true;
                if (indent === rowIndent + 2 && /^config:\s*$/.test(line.trim())) {
                    // config 列表为空 = 其后到块尾没有更深缩进的 `- ` 项
                    let k = j + 1;
                    let sawItem = false;
                    let pendingK = [];
                    while (k < lines.length) {
                        const inner = lines[k];
                        if (inner.trim() === '' || inner.trimStart().startsWith('#')) {
                            pendingK.push(inner);
                            k += 1;
                            continue;
                        }
                        const innerIndent = inner.length - inner.trimStart().length;
                        if (innerIndent > indent && inner.trimStart().startsWith('- ')) {
                            sawItem = true;
                            break;
                        }
                        if (innerIndent <= indent)
                            break;
                        pendingK = [];
                        k += 1;
                    }
                    if (!sawItem)
                        configEmpty = true;
                }
                j += 1;
            }
            if (hasGroupMarker && configEmpty) {
                groupEnd = j;
                out.push(...pending);
            }
        }
        if (groupEnd !== -1) {
            i = groupEnd;
            continue;
        }
        out.push(lines[i]);
        i += 1;
    }
    return out.join('\n');
}
/**
 * 从指定 id 的组块中摘除 `isolate:` 块（含其所有子行）。
 *
 * 背景：preset-cleaner 剥离 stock compaction 行后，组内不再有任何
 * `compaction` 服务的提供者。若保留 `isolate` 块，cordis 的 `isolate(name)`
 * 会为被隔离的服务创建全新 symbol（入口局部 realm），其读写**不回落到父
 * realm**（context.ts 文档原话："resolves against the new label instead of
 * the parent's"）。于是 `command-compact` 的 `inject=['commands','compaction']`
 * 在空 realm 里找不到提供者 → 永久 "waiting for compaction" → preset 挂载失败。
 * 摘除 `isolate` 后组变普通组，消费端沿 scope 链解析到宿主平面的
 * ArgpGraphEngine。
 *
 * 只操作指定 id 的组，不碰其他组（如 planning/delegation 的 isolate 是各自
 * 服务的正确生命周期隔离，不能动）。幂等：无 `isolate` 块时零修改。
 *
 * @param source - composition 文本。
 * @param groupId - 要摘除 isolate 的组 id（如 `compaction`）。
 * @returns 修改后文本与是否实际摘除了 isolate 块。
 */
export function stripIsolateBlock(source, groupId) {
    const lines = source.split('\n');
    const out = [];
    let i = 0;
    let found = false;
    while (i < lines.length) {
        const line = lines[i];
        const groupMatch = /^(\s*)- id: (\S+)\s*$/.exec(line);
        if (groupMatch !== null && groupMatch[2] === groupId) {
            const groupIndent = groupMatch[1].length;
            out.push(line);
            i += 1;
            // 扫描组块内的行（缩进 > groupIndent 的行属于组）
            while (i < lines.length) {
                const cur = lines[i];
                const curTrimmed = cur.trim();
                const curIndent = cur.length - cur.trimStart().length;
                // 组块结束：非空非注释行缩进 <= groupIndent
                if (curTrimmed !== '' && !curTrimmed.startsWith('#') && curIndent <= groupIndent) {
                    break;
                }
                // 检测 isolate: 行（组的直接子级，缩进 = groupIndent + 2）
                if (curTrimmed === 'isolate:' && curIndent === groupIndent + 2) {
                    // 跳过 isolate: 行本身
                    i += 1;
                    // 跳过其所有子行（缩进 > groupIndent + 2）
                    while (i < lines.length) {
                        const child = lines[i];
                        const childTrimmed = child.trim();
                        const childIndent = child.length - child.trimStart().length;
                        if (childTrimmed === '' || childTrimmed.startsWith('#')) {
                            i += 1;
                            continue;
                        }
                        if (childIndent > groupIndent + 2) {
                            i += 1;
                            continue;
                        }
                        break;
                    }
                    found = true;
                    continue;
                }
                out.push(cur);
                i += 1;
            }
            continue;
        }
        out.push(line);
        i += 1;
    }
    return { text: out.join('\n'), removed: found };
}
/**
 * 把 shipped preset 的 `- insert:` 声明净化为顶层 modify override 行。
 *
 * 步骤：行手术摘除 stock compaction 行 → 摘除 compaction 组 isolate 块 →
 * 删除空组 → 把 `- insert:` 包装转成顶层 modify 行（去缩进 4，丢弃 `- insert:`
 * 与前导注释）。源已是 modify 行（无 `- insert:`）时包装转换是 no-op，手术幂等。
 * @param source - shipped preset patch 文件文本（含 `- insert:` 包装）。
 * @param options - strip 集合 / isolate 组 id。
 * @returns override 行文本、摘除标记、是否实质修改。
 */
export function purifyPresetPatch(source, options = {}) {
    const strip = options.strip ?? DEFAULT_STRIP_ROWS;
    const isolateGroup = options.isolateGroup ?? DEFAULT_ISOLATE_GROUP;
    const stripped = stripPresetRows(source, strip);
    const deisolated = stripIsolateBlock(stripped.text, isolateGroup);
    const finalText = dropEmptyGroups(deisolated.text);
    const removed = [...stripped.removed];
    if (deisolated.removed)
        removed.push(`isolate:${isolateGroup}`);
    const text = toModifyRow(finalText);
    const changed = text !== toModifyRow(source);
    return { text, removed, changed };
}
/**
 * 把 `- insert:` 包装的 preset 行转成顶层 modify 行。
 *
 * 定位 `- insert:` 行后的第一个 `- id:` 列表项，取其到文件尾的所有行并整体
 * 去缩进（= 该 `- id:` 行的缩进，shipped 文件恒为 4）；丢弃 `- insert:` 行与
 * 其前的注释。空行原样保留（无缩进可去）。源无 `- insert:` 包装时原样返回
 * （幂等：对已是 modify 行的文本是 no-op）。
 * @param source - preset patch 文本。
 * @returns 顶层 modify 行文本。
 */
export function toModifyRow(source) {
    const lines = source.split('\n');
    const insertIdx = lines.findIndex(l => l.trim() === '- insert:');
    if (insertIdx === -1)
        return source;
    let rowIdx = -1;
    for (let i = insertIdx + 1; i < lines.length; i += 1) {
        if (/^\s*- id: \S+/.test(lines[i])) {
            rowIdx = i;
            break;
        }
    }
    if (rowIdx === -1)
        return source;
    const rowIndent = lines[rowIdx].length - lines[rowIdx].trimStart().length;
    const out = [];
    for (let i = rowIdx; i < lines.length; i += 1) {
        const line = lines[i];
        out.push(line.trim() === '' ? '' : line.slice(rowIndent));
    }
    return out.join('\n');
}
