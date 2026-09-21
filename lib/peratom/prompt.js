// ---------------------------------------------------------------------------
// Prompt（单次调用覆盖当轮全部可压原子；规则前言吸收 P0 三层对冲 + 已知债务 6 修正）
// ---------------------------------------------------------------------------
const PROMPT_RULES = [
    '你是会话压缩器。输入列出本轮全部可压缩原子，你的输出决定它们的压缩形态。',
    '',
    '## 用户长消息拆分（splits）',
    '- 把每条用户消息划分为指令(dialog)片段与资料(info)余量：指令=用户要求做的事、提出的问题、约束或偏好（包括"注意X""别动Y""用Z"限定语）；资料=用户粘贴/附带的一切非指令内容，例如日志、代码、配置、报错、外部评审/方案、文献原文、说明、表格数据、文档引用等。',
    '- quotes 数组逐字抄写每段连续指令原文：必须与原文完全一致（空白、换行、标点、大小写、全角半角、emoji），禁止改写、翻译、增删任何字符。',
    '- 片段按原文出现顺序排列；同一段连续指令不要拆成多段，不相邻的指令不要合并成一段。',
    '- 保守纪律：任何可能包含指令语义的片段都必须抄入 quotes——错误方向只允许往 dialog 错；存档/转发类引导语算资料。',
    '- 未抄写的部分视为资料，会被聚合成可压缩副本。',
    '- infoLevel 决定资料的压缩方式：false=资料很短或无可压空间（infoText 留空，保留原文）；summary=叙述性资料（外部评审、方案、讨论记录、说明）用简洁概括，概括中保留出现的函数名、版本号、API、路径、错误码等精确串；extract=含精确串的资料（shell 报错、日志行、代码片段）逐字保留有用部分、丢弃噪声，infoText 必须与原文逐字一致（空白、换行、标点、大小写全部原样），禁止改写。',
    '- 档位判断：外部 AI 的评审/方案/记录、长段说明 → summary；shell 报错、含错误码/路径/行号的内容 → extract；短小或无冗余 → false。',
    '- infoText 必填：summary/extract 时写入压缩结果；false 时留空字符串。',
    '',
    '## 工具结果压缩（tools）',
    '- 对每个原子做三选一判断（extract / summary / false），把判断与压缩内容写进同一条 {"seq","level","text"}：',
    '- 判断为摘取（level="extract"）：内容含结构化数据或精确串（日志行、配置、代码、命令输出），关键信息依赖原文措辞 → text 必须是所选原文片段的逐字完整拷贝——与原文完全一致（空白、换行、标点、大小写、全角半角、emoji 全部原样），禁止改写、翻译、增删、合并或重新组织任何字符；未选中的行视为噪声直接丢弃。',
    '- 判断为摘要（level="summary"）：内容是冗长叙述性文本、概括不损失关键信息 → text 用简洁概括替换全文；若原文仍有个别必须精确保留的串（错误码、标识符、路径等），把它们原样写进概括文本。保真口径（对外契约）：summary 档只保证结构化承重 token（URL/路径/file:line/UUID/哈希/key=value 等）逐字存活，散文级引用不保证逐字——概括改写散文是本职，不是缺陷。',
    '- 判断为不压（level="false"）：原子全是关键内容、无可丢弃的噪声（典型如完整源码模块、无任何冗余的文本）→ 保留原文，text 留空字符串，不要输出压缩副本。',
    '- 档位由你按每个原子的内容性质自行判断，不必统一。判断标准：确有可丢弃的噪声/冗余时才选 extract 或 summary（text 必须比原文显著缩短）；没有可压空间或拿不准时，显式选 false（从输出里省略该 seq 也等价）。禁止全文照抄一遍（如 level=extract 且 text≈原文），那既浪费 token 又无压缩收益。',
    '',
    '## 输出',
    '只输出一个 JSON 对象：{"splits":[{"seq":<整数>,"quotes":["…"]}],"tools":[{"seq":<整数>,"level":"extract"|"summary"|"false","text":"…"}]}',
    '- seq 原样返回输入给出的值；不需要压缩的原子不要出现在输出里（视为保原文）。',
].join('\n');
export function buildPrompt(collect) {
    const atoms = [];
    for (const u of collect.userLong) {
        atoms.push(`<ATOM seq=${u.seq} kind="user-long">\n${u.text}\n</ATOM>`);
    }
    for (const t of collect.toolResults) {
        atoms.push(`<ATOM seq=${t.seq} kind="tool-result">\n${t.text}\n</ATOM>`);
    }
    return PROMPT_RULES + '\n\n' + atoms.join('\n\n');
}
// ---------------------------------------------------------------------------
// LLM 调用（OpenAI 兼容 fetch + JSON Schema 强制输出，失败降级裸 prompt）
// ---------------------------------------------------------------------------
const OUTPUT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['splits', 'tools'],
    properties: {
        splits: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['seq', 'quotes', 'infoLevel', 'infoText'],
                properties: {
                    seq: { type: 'integer' },
                    quotes: { type: 'array', items: { type: 'string' } },
                    infoLevel: { type: 'string', enum: ['false', 'summary', 'extract'] },
                    infoText: { type: 'string' },
                },
            },
        },
        tools: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['seq', 'level', 'text'],
                properties: {
                    seq: { type: 'integer' },
                    level: { type: 'string', enum: ['extract', 'summary', 'false'] },
                    text: { type: 'string' },
                },
            },
        },
    },
};
/**
 * A 形态（设计文档 §4 tail-only 语义）：压缩调用站在 agent 链延长线上——
 * `[...agent 当前 deriveMessages() 的 wire 渲染, {user: 压缩指令}]`。
 *
 * ⚠️ 复用率实测（2026-09-19 record2 + .tmp/kv-a2-diag5 隔离实验，长历史）：
 * Qwen3 模板的 reasoning 渲染受"最后一条 user 位置"门控——末尾是 user 指令时，
 * 最后一条 user **之后**的 assistant reasoning 在 agent 上一发（P_last）里全渲染、
 * 在本请求里全剥离 ⇒ 前缀从该处起分叉。长历史（轮内 reasoning 多）实测 LCP 仅 30.3%
 * （pt:false）/ 12.7%（pt:true 反而更差：把 P_last 剥掉的跨轮 reasoning 又渲染回来）；
 * 短历史（turn1 末，reasoning 极少）才 ≈100%。⇒ **A 形态的真实复用率是历史长度依赖的**，
 * 此前"完全复用 / LCP=100%"的注释与结论均基于短历史假象，已作废。
 * 若要长历史下接近完全复用，需 A-4（尾部指令用 assistant 承载，实测 LCP=100%）
 * 或 A-3（前缀截断到最后一条 user，自身复用率 87.1%，compaction-basic 同款形态）。
 * 本函数在 A 形态下仍强制 `preserve_thinking:true`（维持既有行为），待形态拍板后统一调整。
 */
export async function postChat(fetchImpl, ep, prompt, timeoutMs, useJsonSchema, chatTemplateKwargs, 
/** A 形态前缀（serializeWireMessages 产物）；缺省 = C 形态独立 one-shot。 */
contextWire, 
/** A 形态 tools 透传（requestHeader().tools 的 wire 渲染）。 */
contextTools, 
/** 输出 cap（token）。压缩输出是 JSON plan，通常几百 token；设小 cap 给 prompt 让出 margin（防爆上限）。 */
maxCompletionTokens) {
    const body = {
        model: ep.model,
        messages: contextWire !== undefined
            ? [...contextWire, { role: 'user', content: prompt }]
            : [{ role: 'user', content: prompt }],
        temperature: 0,
    };
    if (maxCompletionTokens !== undefined)
        body['max_completion_tokens'] = maxCompletionTokens;
    if (contextTools !== undefined)
        body['tools'] = contextTools;
    if (useJsonSchema) {
        // JSON Schema 强制输出：支持结构化解码的端点上消灭自由生成失控（plan 已知债务 7 的
        // "服务端 schema 约束"路径）；strict=true 要求全部字段受 schema 约束。
        body['response_format'] = {
            type: 'json_schema',
            json_schema: { name: 'argp_peratom_turn', strict: true, schema: OUTPUT_SCHEMA },
        };
    }
    // ctk 由调用方解析（resolveEffectiveCtk：继承主链 requestHeader ctk + enable_thinking:false
    // 覆盖）。此处不再强制 preserve_thinking——2026-09-19 定案：A 形态末尾 user 指令把
    // last_query_index 推到末尾，pt:true 反而把 P_last 剥掉的跨轮 reasoning 渲染回来
    // （LCP 12.7% < pt:false 30.3%）；继承主链 ctk 才是同态渲染的正确姿势。
    if (chatTemplateKwargs !== undefined && Object.keys(chatTemplateKwargs).length > 0) {
        body['chat_template_kwargs'] = chatTemplateKwargs;
    }
    const res = await fetchImpl(ep.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ep.apiKey}` },
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify(body),
    });
    if (!res.ok)
        throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = await res.json();
    return json.choices?.[0]?.message?.content ?? '';
}
// ---------------------------------------------------------------------------
// 后端选路
// ---------------------------------------------------------------------------
/**
 * 后端选路（§11.13.1）：显式 `config.llm` > fetch（endpoint/apiKey/env）> 自动兜底。
 * 三条都解不出返回 null —— 调用方按 disabled 记账（`no-endpoint`），不抛错、不阻断会话。
 */
export function backend(host) {
    if (host.dshLlm !== null)
        return { kind: 'dsh-llm', spec: host.dshLlm };
    if (host.endpoint !== null)
        return { kind: 'fetch', endpoint: host.endpoint };
    if (host.autoLlm !== null)
        return { kind: 'dsh-llm', spec: host.autoLlm };
    return null;
}
