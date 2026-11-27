import { sessionEvents, eventText } from './log-access.js';
import { ARG_NS, isArgpUserInfo, isOwnSourceKind } from './llm/types.js';
/**
 * A8（问题 10 修订）：ask 检测中英双语纯函数。
 * 英文：'?' / ask / what；中文：？/ 吗 / 呢 / 什么 / 怎么 / 如何 / 能否 / 能不能。
 * /帮我/ 由子串收窄为句首（^请|^帮我|^能不能|^能否），避免 "顺便帮我带个话" 之类
 * 非问句/非请求主语误命中；疑问词 什么/怎么/如何 仍保留子串（问句核心成分，方向保守=少剪）。
 * 导出供测试直接锁定收窄行为。
 */
export function looksAskText(text) {
    const t = text.trim();
    return t.endsWith('?') || /\bask\b/i.test(t) || /\bwhat\b/i.test(t)
        || t.endsWith('？') || /吗[？?。]?$/.test(t) || /呢[？?。]?$/.test(t)
        || /什么|怎么|如何|能否|能不能/.test(t)
        || /^(请|帮我|能不能|能否)/.test(t);
}
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
export function classifyUserMessage(data) {
    if (isArgpUserInfo(data))
        return 'U';
    return isOwnSourceKind(data?.source?.kind) ? 'X' : 'U';
}
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
export function atomize(host, session) {
    const atoms = [];
    for (const seq of session.surface.nodes) {
        const event = sessionEvents(session)[seq];
        if (event === undefined)
            continue;
        const data = event.data;
        const turn = typeof data?.turn === 'number' ? data.turn : 0;
        if (event.type === 'user/message') {
            // P0 分类陷阱防线：先认 data[argp].info（U-info 聚合副本），再判 plugin-source → X
            const kind = classifyUserMessage(data);
            // P4：U-info 投影 sourceSeq（原始用户消息日志 seq）——历史 U-info 副本的恢复目标。
            const uInfoMeta = data?.[ARG_NS];
            const uSourceSeq = typeof uInfoMeta?.sourceSeq === 'number' ? uInfoMeta.sourceSeq : undefined;
            const userAtom = { id: atoms.length, seq, type: kind, turn, text: eventText(session, seq), toolCallIds: [] };
            if (uSourceSeq !== undefined)
                userAtom.sourceSeq = uSourceSeq;
            atoms.push(userAtom);
            continue;
        }
        if (event.type === 'assistant/message') {
            const text = eventText(session, seq);
            const msg = data?.message;
            const content = Array.isArray(msg?.content) ? msg?.content : [];
            const toolCallIds = content.filter(b => b.type === 'tool-call' && typeof b.id === 'string').map(b => b.id);
            atoms.push({ id: atoms.length, seq, type: 'A', turn, text, toolCallIds });
            continue;
        }
        if (event.type === 'tool/result') {
            // callId 双读（审查 P0-4）：model.source.callId（V4 常见）→ 内容块 toolCallId
            // （V3 内嵌 tool-result）→ message.toolCallId（V4 tool 角色）。与 factor-atoms 同口径。
            const d = data;
            const rawCallId = d?.message?.source?.callId
                ?? d?.message?.content?.find(b => b?.toolCallId !== undefined)?.toolCallId
                ?? d?.message?.toolCallId;
            const callId = typeof rawCallId === 'string' ? rawCallId : undefined;
            atoms.push({ id: atoms.length, seq, type: 'R', turn, text: eventText(session, seq), toolCallIds: callId === undefined ? [] : [callId] });
            continue;
        }
        if (event.type === 'developer/message') {
            // V4 保留类型（tool-addition / tool-removal；宿主尚未激活生产者/消费者）。
            // 显式 X：与 checkpoint 同档——进台账、永不被剪。
            atoms.push({ id: atoms.length, seq, type: 'X', turn, text: eventText(session, seq), toolCallIds: [] });
            continue;
        }
    }
    return atoms;
}
