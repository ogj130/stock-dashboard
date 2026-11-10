#!/usr/bin/env bash
# 本地服务守护循环。
#
# 为什么需要它：这是一个会一直挂着给人看的服务（菜单栏卡片每 5 秒来取数），
# 一旦进程意外退出，卡片就只剩一行「连不上本地服务」，而谁也没盯着终端。
# 之前发生过一次：日志里最后一条是 200，没有任何错误，进程就没了——
# 没有守护循环的话，这种"静默死亡"只能靠人去发现。
#
# 杀掉 5178 的进程不会让服务消失，循环会在 3 秒后用**新的 dist** 重新拉起，
# 顺带解决「重新构建后 @fastify/static 还挂着旧哈希」的老问题。
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 1

PORT="${PORT:-5178}"
LOG="${LOG:-/tmp/qdii-server.log}"

log() { printf '[supervisor] %s %s\n' "$(date '+%F %T')" "$*" >>"$LOG"; }

while true; do
  log "启动 server（PORT=${PORT}，参数：$*）"
  PORT="$PORT" pnpm exec tsx src/server.ts "$@" >>"$LOG" 2>&1
  code=$?
  # 137 = 我们自己的 kill（改完代码/重建 dist 后重启），不必大惊小怪
  if [ "$code" -eq 137 ] || [ "$code" -eq 143 ]; then
    log "被终止（code=${code}），重启"
  else
    log "异常退出 code=${code}，3 秒后重启"
  fi
  sleep 3
done
