#!/usr/bin/env bash
# 边价值四臂驱动（设计 docs/edge-value-4arm-design.md，台账 D20/D2）
#
# 跑法（27B 主裁决模型，免费高服从）：
#   ARGP_MODEL_SOURCE=qwen-local QWEN_MODEL=Qwen3.8-27B QWEN_BASE=http://127.0.0.1:8080/v1 \
#   QWEN_CONTEXT_WINDOW=262144 ARGP_CONTEXT_WINDOW=262144 \
#   bash spike/run-edge-value.sh
# 或换 v4-flash 正式证据档（需 ARGP_DEEPSEEK_THINKING=enabled 调 high）：
#   ARGP_MODEL_SOURCE=deepseek-official bash spike/run-edge-value.sh
#
# 产物：
#   spike/out/edge-A2-*/result.json        A₂ 真跑（契约+边）
#   spike/out/edge-A1-*/result.json        A₁ 真跑（无边）
#   spike/out/edge-A0-*/result.json        A₀ 真跑（无契约无边；06-tlong 中契约=cites 指令句故与 A₁ 同构，设计待确认项1）
#   <A2_DIR>/shadowed-{clear,cites,oracle}.json   28 重放三边源保留集（P1）
#
# 判决：node spike/edge-value-report.mjs <A2_DIR> [A1_DIR]
#
# 注意：各臂输出重定向到 /tmp/edge-<arm>.log（不管道 grep，避免后台管道 SIGPIPE/SIGHUP
# 杀死命令树；也不用多行反斜杠续行变量 COMMON——沙箱 sh 会把续行内的换行解析成命令分隔，
# 报 "ARGP_MODEL_SOURCE=...: command not found"）。
set -u
cd "$(dirname "$0")/.."
LOADER=./scripts/ts-import-rewrite-loader.mjs
NODE_BIN="${NODE_BIN:-node}"

WT=${ARGP_WINDOW_TOKENS:-22000}
RT=${ARGP_RETAIN_TOKENS:-6000}
MT=${ARGP_MAX_TURNS:-50}

# 公共环境变量：逐行 export（绝不写成多行反斜杠续行变量）
export ARGP_MODEL_SOURCE=${ARGP_MODEL_SOURCE:-qwen-local}
export QWEN_MODEL=${QWEN_MODEL:-Qwen3.8-27B}
export QWEN_BASE=${QWEN_BASE:-http://127.0.0.1:8080/v1}
export QWEN_CONTEXT_WINDOW=${QWEN_CONTEXT_WINDOW:-262144}
export ARGP_CONTEXT_WINDOW=${ARGP_CONTEXT_WINDOW:-262144}
export ARGP_WINDOW_TOKENS=$WT
export ARGP_RETAIN_TOKENS=$RT
export ARGP_MAX_TURNS=$MT
export ARGP_WATCHDOG_MIN=90

# A₂：契约+边（默认 citesOn=true）
echo "########## A2 (契约+边) ##########"
ARGP_CITES_ON=true ARGP_RUN_NAME=edge-A2 $NODE_BIN --import "$LOADER" spike/06-tlong.ts > /tmp/edge-A2.log 2>&1
echo "[A2] exit=$? ; tail:"; tail -3 /tmp/edge-A2.log

# A₁：无边（citesOn=false，且引擎 disableCiteEdges=true → 确定性无边）
echo "########## A1 (无边) ##########"
ARGP_CITES_ON=false ARGP_RUN_NAME=edge-A1 $NODE_BIN --import "$LOADER" spike/06-tlong.ts > /tmp/edge-A1.log 2>&1
echo "[A1] exit=$? ; tail:"; tail -3 /tmp/edge-A1.log

# A₀：无契约无边（裸基线；与 A₁ 同构，设计标注可后置/省略；RUN_A0=1 才跑）
if [ "${RUN_A0:-0}" = "1" ]; then
  echo "########## A0 (无契约无边) ##########"
  ARGP_CITES_ON=false ARGP_RUN_NAME=edge-A0 $NODE_BIN --import "$LOADER" spike/06-tlong.ts > /tmp/edge-A0.log 2>&1
  echo "[A0] exit=$? ; tail:"; tail -3 /tmp/edge-A0.log
else
  echo "[SKIP] A0 未启用（RUN_A0!=1；设计标注 A0 可后置，且与 A1 同构）"
fi

# A₃：离线重放 A₂ events，边源（P1 保留集差异）
#   clear / cites 两端源必跑（P1 对称差核心）；oracle 源需 ORACLE_EDGES（设计开放项 #2：
#   生成器待写），未提供则跳过，不阻断 D2 判决。
A2_DIR=$(ls -d spike/out/edge-A2-* 2>/dev/null | sort | tail -1)
if [ -z "$A2_DIR" ]; then echo "[FATAL] 未找到 edge-A2 产物目录（A2 是否失败？看 /tmp/edge-A2.log）"; exit 1; fi
echo "########## A3 离线重放 (用 $A2_DIR) ##########"
for SRC in clear cites; do
  echo "----- EDGE_SOURCE=$SRC -----"
  EDGE_SOURCE=$SRC ARGP_WINDOW_TOKENS=$WT ARGP_RETAIN_TOKENS=$RT \
    $NODE_BIN --import "$LOADER" spike/28-simulated-replay.ts "$A2_DIR" > /tmp/edge-A3-$SRC.log 2>&1
  echo "[A3-$SRC] exit=$? ; tail:"; tail -3 /tmp/edge-A3-$SRC.log
done
if [ -n "${ORACLE_EDGES:-}" ]; then
  echo "----- EDGE_SOURCE=oracle -----"
  EDGE_SOURCE=oracle ARGP_WINDOW_TOKENS=$WT ARGP_RETAIN_TOKENS=$RT \
    ORACLE_EDGES=$ORACLE_EDGES \
    $NODE_BIN --import "$LOADER" spike/28-simulated-replay.ts "$A2_DIR" > /tmp/edge-A3-oracle.log 2>&1
  echo "[A3-oracle] exit=$? ; tail:"; tail -3 /tmp/edge-A3-oracle.log
else
  echo "[SKIP] EDGE_SOURCE=oracle 未提供 ORACLE_EDGES，跳过（设计开放项 #2：oracle 边生成器待写）"
fi

echo "===== EDGE-VALUE RUN DONE ====="
echo "判决：node spike/edge-value-report.mjs $A2_DIR spike/out/$(ls -d spike/out/edge-A1-* 2>/dev/null | sort | tail -1)"
