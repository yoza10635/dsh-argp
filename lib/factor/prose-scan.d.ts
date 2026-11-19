/** 宿主注入 boilerplate 名册（§6.5 实测 kind）；own kinds 另经 isOwnSourceKind。 */
export declare const HOST_BOILERPLATE_SOURCE_KINDS: readonly string[];
/** cap 缺省系数：窗 tok × 密度 chars/tok × 本系数（≈2.7 倍单窗全满散文线，D3/R9④）。 */
export declare const DEFAULT_PROSE_SCAN_WINDOW_FACTOR = 2.7;
/** cap=0 ⇒ 关闭；缺省=窗相对值。config `proseScanCapChars` 覆盖（测试注入形）。 */
export declare function defaultProseCapChars(windowTokens: number, charsPerToken: number): number;
interface ProseEventLike {
    type?: string;
    surfaceOp?: unknown;
    data?: unknown;
}
/** 扫描排除的来源 kind：本引擎自写（note/检查点）+ 宿主 boilerplate。 */
export declare function isProseExcludedKind(kind: string | undefined): boolean;
/**
 * 仅 text 块的逐字投影（P4★：不含 tool-call 块、不含 args；reasoning 不扫）。
 * user/message 双形读（P11）。无 text 块返回 null（与 rawEventText 的 null 语义对齐）。
 * 多 text 块以 '\n' 连接（块间分隔符=投影，装配层如展示需如实注记）。
 */
export declare function proseTextOf(event: ProseEventLike): string | null;
/** 是否入扫描面的候选事件（形+kind；text 非空判定留给调用方，避免双投影）。 */
export declare function isProseCandidate(event: ProseEventLike): boolean;
/** 命中位置上限（fragment 选取只用到首尾几处，封顶防超大原子的命中数组膨胀；count 仍如实全计）。 */
export declare const HIT_POSITIONS_CAP = 50;
/**
 * 非重叠 indexOf 收集命中：全量 count + 前 HIT_POSITIONS_CAP 个偏移（小写化文本口径）。
 * 命中面单点（search_history 工具带 + 散文带共用），杜绝两处 indexOf 漂移。
 */
export declare function collectHits(text: string, needleLower: string): {
    count: number;
    positions: number[];
};
export interface ProseHit {
    seq: number;
    /** 命中次数（原始 TF；饱和计分是装配层 D11 的事，扫描面如实）。 */
    hits: number;
    /** 首个命中在**小写化投影文本**中的字符偏移（=positions[0]，向后兼容保留）。 */
    first: number;
    /** 前若干命中偏移（多 fragment 预览用，≤HIT_POSITIONS_CAP）。 */
    positions: number[];
    /** 投影文本字符数（装配层展示长度用，免二次投影）。 */
    chars: number;
}
export interface ProseScanResult {
    /** 按 seq 升序（从旧到新）。 */
    hits: ProseHit[];
    /** 实际扫描的投影字符数（cap 计数基准=投影原始 chars，非 lower 后，P8★）。 */
    scannedChars: number;
    /** cap 触发截断=true：更旧扫描序内还有未扫内容，装配层必须 footer 显式。 */
    truncated: boolean;
    /** cap=0 ⇒ 带关闭（与 truncated 区分：关闭无「未扫」告警义务）。 */
    disabled: boolean;
}
/**
 * 散文带扫描（events=sessionEvents 全量数组，needle=已小写化 needle）。
 * 从旧到新逐候选：投影 → 计数入 cap → 小写化找 hits/first；cap 触线即停。
 */
export declare function scanProseHits(events: readonly ProseEventLike[], needle: string, capChars: number): ProseScanResult;
export {};
