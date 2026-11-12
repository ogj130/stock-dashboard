#!/usr/bin/env bash
# 改完代码后的一键重载：构建前端 → 重启后端 → **重新拉起菜单栏卡片**。
#
# 用户的明确要求（2026-11-11）：「你每次改完之后，需要自动给我把 mac 的小卡片拉起来」。
# 原因是卡片是一个常驻的 WKWebView 窗口：后端重建后它手里还是旧页面的哈希资源，
# 不重新拉就会空白或者停在旧数据上——那种"改了却看不到"的体验比报错更浪费人。
#
# 顺序不能换：先构建，再重启后端（launchd 会用新 dist 起），最后拉卡片。
# 卡片最后拉，是因为它一加载就要打后端接口。
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 1

PORT="${PORT:-5178}"
CARD_APP="tools/mac-card/dist/StockCard.app"
CARD_BIN="StockCard.app/Contents/MacOS/StockCard"
log() { printf '%s %s\n' "$(date '+%H:%M:%S')" "$*"; }

echo "==> 1/4 构建前端"
pnpm exec vite build >/tmp/qdii-build.log 2>&1 || { log "构建失败，见 /tmp/qdii-build.log"; exit 1; }
log "dist 就绪"

echo "==> 2/4 重启后端"
# 交给 launchd（KeepAlive）重启；没装 launchd 的环境退化成 serve.sh 的错误提示
lsof -ti:"${PORT}" | xargs -r kill -9
for _ in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/api/health" || true)
  [ "$code" = "200" ] && break
  sleep 0.5
done
if [ "$code" != "200" ]; then
  log "后端没起来（HTTP ${code}）：检查 launchctl print gui/$(id -u)/local.qdii.server"
  exit 1
fi
log "后端 200"

echo "==> 3/4 重建卡片 .app"
# 只在源码比产物新时重建：Swift 编译要几秒，而多数改动只是前端
if [ ! -x "${CARD_APP}/Contents/MacOS/StockCard" ] || \
   [ tools/mac-card/card.swift -nt "${CARD_APP}/Contents/MacOS/StockCard" ]; then
  ( cd tools/mac-card && ./build.sh >/tmp/qdii-card-build.log 2>&1 ) || {
    log "卡片构建失败，见 /tmp/qdii-card-build.log"; exit 1; }
  log "卡片已重建"
else
  log "卡片源码未变，跳过编译"
fi

echo "==> 4/4 拉起卡片"
pkill -f "${CARD_BIN}" 2>/dev/null || true
sleep 0.4
# 重建会把整个 .app 删掉重写，LaunchServices 里可能还记着旧 bundle 的 inode。
# 不重新登记时 `open` 会报「executable is missing」——文件明明在，2026-11-12 实际踩到过。
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
if [ -x "${LSREGISTER}" ]; then
  "${LSREGISTER}" -f "$(cd "$(dirname "${CARD_APP}")" && pwd)/$(basename "${CARD_APP}")" 2>/dev/null || true
fi
open "${CARD_APP}"
for _ in $(seq 1 20); do
  pid=$(pgrep -f "${CARD_BIN}" | head -1 || true)
  [ -n "${pid}" ] && break
  sleep 0.3
done

if [ -n "${pid:-}" ]; then
  log "卡片已启动 pid=${pid}"
else
  log "卡片没起来：手动 open ${CARD_APP} 看看"
  exit 1
fi
