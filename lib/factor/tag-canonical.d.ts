/**
 * canonical 单点（design-2.0 §1.3 P0 不变量）：贴标侧与查询侧**必须共用**本模块，
 * 两侧各写一份 normalize 是本方案最可能的静默死法（变异测试钉死于 test/tag-canonical.test.ts）。
 *
 * 纯函数、零依赖（含零 fs——事件时 cwd 由调用方作为参数注入，缺失即 rel: 标记，
 * 绝不拿调用方当前 cwd 凑）。
 */
import type { LabelReject } from './types.ts';
/** null = 允许；非 null = 拒收原因。拒收者留索引、不进 prompt（fail-closed）。 */
export declare function labelAllowed(label: string): LabelReject | null;
export interface CanonicalPath {
    key: string;
    /** 相对路径且无事件时 cwd 可绑（canonical 冲突审计计数对象；保守不合并）。 */
    unboundRel: boolean;
}
/** 剥离尾部行号引用（`a.ts:12:3` → `a.ts`）——document 键按文件粒度归并。 */
export declare function stripLineRef(raw: string): string;
/**
 * 规则（P0 实测形态）：
 *  反斜杠归一 → `./` 剥离 → 行号剥离 → msys/盘符归形 → 尾/双斜杠归并；
 *  unix 绝对路径与 `~/` 保留大小写，盘符键小写合并。
 *  相对路径：只绑**事件在场 cwd**（参数注入，同一归形管道）；
 *  无 cwd → `rel:` 前缀 + unboundRel（保守不合并）。
 */
export declare function canonicalPath(raw: string, cwd?: string): CanonicalPath | null;
/**
 * args → 语义指纹：string 先 JSON.parse（宿主两态，log-access.ts:195-199），对象直用；
 * 键深度排序 + 空白规整 ⇒ `{a:1,b:2}` 与 `{"b":2, "a":1}` 同指纹。
 * 不可解析 → trim 后的原文（仍可比，只是退化为字面）。
 */
export declare function canonicalArgsFp(raw: unknown): string;
