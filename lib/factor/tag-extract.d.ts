import type { ExtractInput, RTags } from './types.ts';
export declare const GREP_TOOLS: ReadonlySet<string>;
export declare const WRITE_TOOLS: ReadonlySet<string>;
export declare const READ_TOOLS: ReadonlySet<string>;
export declare const COMMAND_TOOLS: ReadonlySet<string>;
/**
 * command-medium 白名单（§2.5 v1.1：焦点命令**只参与排序，永不进 hard**；
 * family=首 token 太粗——实测 cd 族保留面爆（语料 36 档 72 枚/81KB）、
 * PowerShell `$env:…` 伪家族剥不掉，故族名必须白名单准入）。
 * 准入=语料高频 dev-execution 族（2026-11-11 实测 36 档：node 987 枚、git 257、
 * npm 43、python 43、pip 43；grep 173 为检索载体不入表）；导航/翻文件族不入——
 * cd 族爆炸半径已定谳，cat/sed/ls 里"命令"只是载体。增删本表须由 T-2 medium 面占比闸复测背书。
 */
export declare const COMMAND_MEDIUM_FAMILY_WHITELIST: ReadonlySet<string>;
/** args 双形（宿主 tool/call arguments = JSON string 或已解析对象）统一解析；
 *  interactive.ts 预览提取共用（canonical 单点：两处各写一份 JSON 容差是漂移源）。 */
export declare function parseArgsObj(raw: unknown): Record<string, unknown> | null;
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
