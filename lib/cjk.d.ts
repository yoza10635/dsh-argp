/** 白名单内 CJK 字符计数（codePoint 级，代理对安全）。 */
export declare function countCjkChars(text: string): number;
/** 由统计对算加权 token 估算（浮点；取整在消费点）。非 CJK 文本 = chars/3.5 精确浮点。 */
export declare function estTokensFromStats(chars: number, cjk: number): number;
/** 单串便捷入口（内部走 stats）。 */
export declare function estTokens(text: string): number;
