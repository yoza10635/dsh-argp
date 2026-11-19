/**
 * `search_history`：内容发现工具（design-prose-keyword-recall v2.2 刀 B）。
 *
 * 三工具正交（D8′ 用户裁定）：`list_labels`=看词表、`search_history`=找（内容子串，
 * 覆盖被剪工具原子 **+ user/assistant 散文原文**——含已被浓缩请离场的文本）、
 * `recall_history`=取（标签地址）。两步走=本工具回 hit=<seq> 句柄+分层预览，
 * `hit=` 第二跳取全文（刀 C；本刀先把索引槽落好）。
 *
 * 协议要点（三轮台账）：
 *  - N=命中集总数，缺省铺满至 RECALL_SEARCH_FACET_N（limit 缺省不生效，D9 用户裁定）；
 *  - 分层预览（§6.6 SERP snippet 预算制）：N≤20→100tok、N≤250→20tok、显式 limit 页→200tok；
 *    预览总宽再受单次 5% 预算行均摊 min 钳（R5★：先缩预览后削行，削行必发 footer）；
 *  - 排序 score=min(hits, TF_CAP) desc → seq asc（D11 TF 饱和=BM25 饱和项整数最简形；
 *    断键显式化 R6）；
 *  - labels 过滤在场时候选=账本交集逐字不动、散文不参与（门 wanted=0∧keys=0，P12）；
 *  - 散文带独立 cap（从旧到新保最旧，P7★）+ truncated 页脚显式（fail-visible，R8①）；
 *  - live 行 >K 合并成一行提示（S10/P9：预览与预算不被自身回声支配）；
 *  - 行内控制符压平=内容切片专属（R8：引擎分隔符不受影响）；
 *  - 两带合并文本**恰过一次** budgetRecallText（P14），footer 预算外拼接（:401-406 纪律）；
 *  - 零新参数之外的参数键集在刀 C 前冻结（hit= 随 C 加入）。
 */
import type { Context } from '@deepseek-ai/cordis';
import { type RecallLabelsHost } from './recall-labels.ts';
import type { FactorEngine } from './engine.ts';
/**
 * 分层预览六步口径（R10，golden-string 可锁）：①原文定窗 [first−W, first+len+W]
 * ②两端回退最近行边界 ③切片 ④切片压平控制符 ⑤estTokens 前缀累加取 ≤tok 最长
 * codePoint 前缀 ⑥截断补 …（不回测）。
 */
export declare function buildPreview(text: string, first: number, needleLen: number, tok: number, cpt: number): string;
export declare function registerSearchHistory(ctx: Context, factor: FactorEngine, host: RecallLabelsHost): void;
