#!/usr/bin/env bash
# 把 QDII 估值服务装成系统级常驻（LaunchAgent）。
#
# 装完之后：登录自动启动；进程退出自动拉起；崩溃信息落 ~/Library/Logs/qdii-server.log。
# 这是「菜单栏卡片永远连得上」的前提——手动 nohup 起的进程会随终端/会话消失。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC="${ROOT}/tools/dev/local.qdii.server.plist"
DST="${HOME}/Library/LaunchAgents/local.qdii.server.plist"
LABEL="local.qdii.server"
UID_NUM="$(id -u)"

mkdir -p "${HOME}/Library/LaunchAgents" "${HOME}/Library/Logs"

# 已加载就先卸掉，避免 bootstrap 报 "already bootstrapped"
if launchctl print "gui/${UID_NUM}/${LABEL}" >/dev/null 2>&1; then
  launchctl bootout "gui/${UID_NUM}/${LABEL}" || true
fi

# 模板里的路径按当前仓库位置替换，换目录后重跑本脚本即可
sed "s#/Users/ouguangji/2026/stock-my#${ROOT}#g" "${SRC}" >"${DST}"
plutil -lint "${DST}" >/dev/null

launchctl bootstrap "gui/${UID_NUM}" "${DST}"
launchctl enable "gui/${UID_NUM}/${LABEL}"

echo "已加载 ${LABEL}"
echo "  日志：${HOME}/Library/Logs/qdii-server.log"
echo "  状态：launchctl print gui/${UID_NUM}/${LABEL}"
echo "  停止：launchctl bootout gui/${UID_NUM}/${LABEL}"
