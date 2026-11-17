/**
 * CJK 自适应密度估算（Issue5，2.1.0）：`estTokens = nonCjkChars/3.5 + cjkChars/κ`。
 *
 * - 白名单（Unicode 区间）：CJK 统一表意 4E00-9FFF、扩展 A 3400-4DBF、
 *   中日韩标点 3000-303F、假名 3040-30FF。
 * - **白名单外一律入 nonCjk 桶按 3.5**（design-2.1.0-batch §3 v2 裁定）：西里尔/希腊/
 *   谚文/emoji/全角等现状就吃 3.5，归 nonCjk = 零新回归；「非 CJK-only 文本估算逐字
 *   不变」等价锁覆盖这类输入。
 * - κ 标定与跨 tokenizer 简化声明见 constants.ts `CJK_CHARS_PER_TOKEN`。
 * - 取整位不在此处：各消费点保留原有 ceil/floor/round（等价性锁），本模块只出浮点值。
 */
import { DEFAULT_CHARS_PER_TOKEN, CJK_CHARS_PER_TOKEN } from './constants.js';
/** 白名单内 CJK 字符计数（codePoint 级，代理对安全）。 */
export function countCjkChars(text) {
    let n = 0;
    for (const ch of text) {
        const o = ch.codePointAt(0);
        if ((o >= 0x3000 && o <= 0x303F) || (o >= 0x3040 && o <= 0x30FF)
            || (o >= 0x3400 && o <= 0x4DBF) || (o >= 0x4E00 && o <= 0x9FFF))
            n++;
    }
    return n;
}
/** 字符统计对（total, cjk）——供已有逐字符遍历的热点复用，避免二次扫串。 */
export function cjkStats(totalChars, cjkChars) {
    return { chars: totalChars, cjk: cjkChars };
}
/** 由统计对算加权 token 估算（浮点；取整在消费点）。非 CJK 文本 = chars/3.5 精确浮点。 */
export function estTokensFromStats(chars, cjk) {
    return (chars - cjk) / DEFAULT_CHARS_PER_TOKEN + cjk / CJK_CHARS_PER_TOKEN;
}
/** 单串便捷入口（内部走 stats）。 */
export function estTokens(text) {
    return estTokensFromStats(text.length, countCjkChars(text));
}
