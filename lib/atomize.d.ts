/**
 * ARGP 原子化模块（2.0 factor-only 收窄）：atomize +
 * user 分类（classifyUserMessage）+ ask 检测（looksAskText）。
 *
 * 循环 import 规避：本模块**不** import hub 运行时。atomize 接收窄接口
 * {@link GraphBuildHost} 而非具体 class；hub 的 class 以
 * `this as unknown as GraphBuildHost` 传入（编译期断言，运行时即真实实例，
 * 私有字段经 host 类型可读写/重赋值）。依赖方向：hub → atomize（单向）。
 */
import type { Session } from '@deepseek-ai/dsh-session';
import type { Atom } from './argp-types.js';
/**
 * 原子化访问引擎状态所需的窄接口。
 * 仅列出 atomize 实际读写的字段；hub 的 ArgpEngine 以
 * `this as unknown as GraphBuildHost` 满足它。
 */
export interface GraphBuildHost {
    session: Session | null;
}
/**
 * A8（问题 10 修订）：ask 检测中英双语纯函数。
 * 英文：'?' / ask / what；中文：？/ 吗 / 呢 / 什么 / 怎么 / 如何 / 能否 / 能不能。
 * /帮我/ 由子串收窄为句首（^请|^帮我|^能不能|^能否），避免 "顺便帮我带个话" 之类
 * 非问句/非请求主语误命中；疑问词 什么/怎么/如何 仍保留子串（问句核心成分，方向保守=少剪）。
 * 导出供测试直接锁定收窄行为。
 */
export declare function looksAskText(text: string): boolean;
/**
 * user/message 原子分类（P0 分类陷阱防线）。
 *
 * 顺序不可交换：先识别 `data[argp].info === true`（U-info 聚合副本——由 peratom 管线
 * 插件 append，但必须按 U 待遇参与剪枝候选），再落「非 `user` 源 → X」（注入/checkpoint）
 * 判定。若先判非-user-source，U-info 会被分类成 X 而**全局不可剪**，
 * P4 的候选放行将永远失效。
 *
 * 判据**版本无关**：真实用户消息恒带 `source.kind === 'user'`（宿主 createUserMessage
 * 约定）；注入（V3 `plugin` / V4 `argp` / `compact-checkpoint`）命中自有来源白名单 ⇒ X。
 * 其余非-user kind（dsh-agent merge 扩展）不是 X——由正交的性质轴（form）裁决。
 * 导出供测试直接锁定顺序行为（A8 先例）。
 */
export declare function classifyUserMessage(data: unknown): 'U' | 'X';
/**
 * 原子化（§4.1）：只投影 surface 节点；U/X/R/A 四类（tool/call 不进 surface，无 T 类）。
 *
 * switch 认四类 surface 事件：`user/message` / `assistant/message` / `tool/result` /
 * `developer/message`；唯一不产出原子的 surface 类型是 `system/message`——
 *
 * node 0 保护（2026-09-10，dsh 0.1.5 起）：宿主把 system prompt 表示为 surface node 0 的
 * `system/message`，并在 surface.ts `assertSystemHeadRewrite` 里硬性保护——任何覆盖 node 0 的
 * replace 必须是"恰好覆盖该单节点的 system/message"，否则 throw。
 * `system/message` **静默跳过、不产出原子**，因此 node 0 永远不会进入 ARGP 的剪枝区间，
 * 上述宿主断言不会被触发。**这是有意依赖，不是巧合**——若日后要支持剪系统提示，
 * 必须同时改这里与宿主契约。
 *
 * `developer/message`（V4 保留类型：tool-addition / tool-removal 块；宿主 ContentBlockMap
 * 注释"providers and UI reject them until their producers and consumers are implemented
 * together"）不像 system head 那样被宿主硬保护，故**显式归类 X**（与 checkpoint 同档）：
 * 进原子台账（手动剪枝段在它处作为**有意边界**断开），但永不压缩、永不被剪。
 * 宿主若日后激活该类型，边界已在此定义，而不是一个意外的非原子漏点。
 */
export declare function atomize(host: GraphBuildHost, session: Session): Atom[];
