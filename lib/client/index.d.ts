/** Structural shape of the assistant blocks the chat renders. */
interface DisplayBlock {
    readonly kind: string;
    readonly text?: unknown;
    readonly [key: string]: unknown;
}
/** Structural face of the native assistantDisplay seam (ui-conversation). */
interface AssistantDisplaySeam {
    register(filter: (blocks: readonly DisplayBlock[], info: {
        readonly streaming: boolean;
    }) => readonly DisplayBlock[]): () => void;
}
/** Structural root context the cordis loader provides to apply. */
interface ArgpClientContext {
    assistantDisplay: AssistantDisplaySeam;
}
/** Services this bundle requires before apply runs. */
export declare const inject: string[];
export declare function apply(ctx: ArgpClientContext): void;
export {};
