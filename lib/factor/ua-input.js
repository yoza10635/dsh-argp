/** 已浓缩形态（二次浓缩禁令；与 constants.DEFAULT_SKIP_CONTEXT_FORMS 同名单）。 */
export const SKIP_SUMMARY_FORMS = ['relay', 'notice'];
/**
 * 宿主每请求**再注入**的上下文三件套（实机铁证 2026-11-25 三域影子对照：prose 域
 * 32K 会话 skill-catalog 注入 4 次 ×8.5KB——压缩驱逐后宿主立即重新注入）。驱逐它们
 * 释放的是**假量**（下一请求原样回来），喂进摘要 transcript 还白烧 LLM token。
 * 焦点域 30KB AGENTS.md 词汇表曾被计为可浓缩散文 10972 tok，把「不该摘」的 B-6
 * 场景误判成「摘」（影子对照抓出的口径 bug）。
 */
export const HOST_REINJECTED_FORMS = ['instructions', 'snapshot', 'catalog'];
export const HOST_REINJECTED_KINDS = ['agent-instructions', 'runtime-context', 'skill-catalog'];
export function classifyUaAtom(atom, probe, hostReinjected = 'prose') {
    if (atom.type === 'X')
        return 'excluded';
    // 已浓缩的 U-info 聚合副本（sourceSeq 即识别判据）：禁二次浓缩。
    if (atom.type === 'U' && atom.sourceSeq !== undefined)
        return 'excluded';
    if (probe.attachment)
        return 'barrier';
    if (atom.type === 'U') {
        if (probe.form !== undefined && SKIP_SUMMARY_FORMS.includes(probe.form))
            return 'excluded';
        if (hostReinjected === 'exclude') {
            // 宿主再注入三件套：form/kind 双通道命中皆排除（真 user 消息 kind='user'、
            // form=undefined，不受影响）。
            if (probe.form !== undefined && HOST_REINJECTED_FORMS.includes(probe.form))
                return 'excluded';
            if (probe.kind !== undefined && HOST_REINJECTED_KINDS.includes(probe.kind))
                return 'excluded';
        }
        return 'textA';
    }
    if (atom.type === 'A')
        return atom.toolCallIds.length > 0 ? 'toolCallA' : 'textA';
    return 'rPair';
}
