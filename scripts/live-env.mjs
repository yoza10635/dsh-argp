// test:live 的 env 预置（--import 阶段执行，先于测试文件加载）：
// 默认指向本机 Qwen 服务；显式 ARGP_ITEST_LLM 优先（可指向其它 OpenAI 兼容端点）。
// npm script 里写 `ARGP_ITEST_LLM=… node …` 在 Windows cmd 下不成立，故用 preload。
process.env.ARGP_ITEST_LLM ||= 'http://127.0.0.1:1234/v1'
