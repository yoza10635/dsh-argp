import { ArgpGraphEngine } from '../argp-graph-engine.js';
import { PeratomCompressor } from './compressor.js';
import { CiteDeclarer } from './cite-declarer.js';
import { RecallZoom } from './recall-zoom.js';
/**
 * 挂载双引擎全栈。幂等性由宿主保证（同一 ctx 不应重复挂载 compaction 位）。
 * 返回管线句柄（测试 / P5 三臂观测用；生产可不保留）。
 */
export async function mountPeratomStack(ctx, config = {}) {
    // 三管线在 graph 之前构造：hook 注册进 ctx 事件总线，graph 的接线闭包捕获句柄。
    // 顺序无竞争——compressor/declarer 的触发钩子（idle）与 zoom 的工具调用都发生在
    // agent loop 运行期，晚于本工厂的同步装配。
    const compressor = config.compressor === false ? null : new PeratomCompressor(ctx, config.compressor ?? {});
    const declarer = config.declarer === false ? null : new CiteDeclarer(ctx, config.declarer ?? {});
    const zoom = config.zoom === false ? null : new RecallZoom(ctx, config.zoom ?? {});
    const graphConfig = { ...config.graph };
    // P2 接线：声明边经 injectEdges 通道进 buildGraph（seq→id 映射与离 surface
    // 丢弃在 declarer.buildInjectEdges 内完成，端点校验在 buildGraph 的 validIds 检查）。
    if (declarer !== null) {
        graphConfig.injectEdges = (atoms) => declarer.buildInjectEdges(atoms);
    }
    // P4 接线：溢出三步第②步 = 当前轮 per-atom 降熵（顺带补 cites）。
    // compressCurrentTurn 失败隔离内建（endpoint 缺失/网络错误只记 record 不抛），
    // 钩子侧另有 try/catch 双保险。
    if (compressor !== null) {
        graphConfig.onOverflowCompress = async (session) => {
            await compressor.compressCurrentTurn(session);
        };
    }
    await ctx.plugin(ArgpGraphEngine, graphConfig);
    return { engine: ctx.compaction, compressor, declarer, zoom };
}
