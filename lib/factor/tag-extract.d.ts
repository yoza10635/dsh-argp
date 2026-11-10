import type { ExtractInput, RTags } from './types.ts';
export declare const GREP_TOOLS: ReadonlySet<string>;
export declare const WRITE_TOOLS: ReadonlySet<string>;
export declare const READ_TOOLS: ReadonlySet<string>;
export declare const COMMAND_TOOLS: ReadonlySet<string>;
/** bash 命令行 → 命令族（剥 `cd X &&` 前缀/环境赋值/sudo；多行取首行）。 */
export declare function commandFamily(cmd: string): {
    family: string | null;
    cwdHint: string | null;
};
/**
 * 对一个 R 贴标。通道纪律（§2.2）：
 *  - 命令族：command 标签 + cwd/dir 作用域（args.cwd/dir 是事件时环境的第二来源）；
 *  - grep 族：path/paths 进 scope（目录语义），不进 document；
 *  - file 族/未知工具：FILE_KEYS 逐个试（值须含 `/ : . \`之一，防 grep pattern 混入）；
 *  - 文本侧兜底**仅在 args 通道空**时启用（增量口径，P0 实测覆盖率按 args 通道计）。
 */
export declare function extractTags(input: ExtractInput): RTags;
