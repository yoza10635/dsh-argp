/** Structural root context the cordis loader provides to apply. */
interface ArgpClientContext {
    /** cordis 可选服务获取：不触发 proxy 的 "without inject" 检查。 */
    get<T>(name: string): T | undefined;
}
/**
 * Graceful degradation: no static inject — the cordis client refuses to read a
 * same-fiber self-registered service during apply ("cannot get property
 * without inject"), and even a guarded `ctx.assistantDisplay?.x` access trips
 * the proxy check. Resolve the seam via `ctx.get()` (returns undefined for
 * absent services, no throw) and skip silently when the host does not
 * provide it.
 */
export declare function apply(ctx: ArgpClientContext): void;
export {};
