/**
 * 缺省端点解析：ARGP_MODEL_SOURCE=qwen-local → QWEN_BASE/QWEN_MODEL（本地推理）；
 * 否则 DeepSeek 生产端点 + DEEPSEEK_API_KEY。apiKey 缺失 → disabled（静默跳过，
 * 开发/离线环境零网络副作用）。
 */
export function defaultEndpoint(env = process.env) {
    if (env['ARGP_MODEL_SOURCE'] === 'qwen-local') {
        return {
            endpoint: (env['QWEN_BASE'] ?? 'http://127.0.0.1:8080/v1') + '/chat/completions',
            model: env['QWEN_MODEL'] ?? 'Qwen3.8-27B',
            apiKey: env['DEEPSEEK_API_KEY'] ?? 'dummy-local',
        };
    }
    const apiKey = env['DEEPSEEK_API_KEY'];
    if (apiKey === undefined || apiKey === '')
        return null;
    return {
        endpoint: env['DEEPSEEK_BASE'] !== undefined ? env['DEEPSEEK_BASE'] + '/chat/completions' : 'https://api.deepseek.com/chat/completions',
        model: env['DEEPSEEK_MODEL'] ?? 'deepseek-v4-flash',
        apiKey,
    };
}
