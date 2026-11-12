/** 已浓缩形态（二次浓缩禁令；与 constants.DEFAULT_SKIP_CONTEXT_FORMS 同名单）。 */
export const SKIP_SUMMARY_FORMS = ['relay', 'notice'];
export function classifyUaAtom(atom, probe) {
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
        return 'textA';
    }
    if (atom.type === 'A')
        return atom.toolCallIds.length > 0 ? 'toolCallA' : 'textA';
    return 'rPair';
}
