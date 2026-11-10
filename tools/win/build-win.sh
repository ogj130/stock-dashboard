#!/usr/bin/env bash
# 打一个 Windows 绿色版：node.exe + server.mjs + 前端 + 启动脚本 → zip
#
# 为什么要带自己的 node.exe：服务端用 node:sqlite（内置 SQLite），
# 那是 Node 22.5+ 才有的内置模块，指望用户机器上的 Node 版本可靠是指望不上。
# 自带一份 77MB 的 node.exe，换来「解压即用、不问环境」。
#
# 数据安全约定（本脚本的红线）：
#   - 只拷贝 dist/ 与 server.mjs，**绝不**碰 data/、*.db、.env
#   - 打完做一次自检：zip 里出现任何 *.db 就直接失败退出
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="${ROOT}/dist-win"
NODE_VER="${NODE_VER:-v24.18.0}"
NAME="QDII-${NODE_VER#v}-win-x64"
PKG="${OUT}/${NAME}"
ZIP="${OUT}/${NAME}.zip"

echo "==> 1/6 清理"
rm -rf "${OUT:?}"
mkdir -p "${PKG}"

echo "==> 2/6 构建前端"
cd "${ROOT}"
pnpm exec vite build >/dev/null
cp -R "${ROOT}/dist" "${PKG}/dist"

echo "==> 3/6 打包服务端 bundle"
node "${ROOT}/tools/win/build-server.mjs" "${PKG}/server.mjs"

echo "==> 4/6 取 Windows node（${NODE_VER}）"
CACHE="${ROOT}/.cache"
mkdir -p "${CACHE}"
ZIPFILE="${CACHE}/node-${NODE_VER}-win-x64.zip"
if [ ! -f "${ZIPFILE}" ]; then
  curl -fL --retry 3 -o "${ZIPFILE}" \
    "https://nodejs.org/dist/${NODE_VER}/node-${NODE_VER}-win-x64.zip"
fi
unzip -o -q "${ZIPFILE}" "node-${NODE_VER}-win-x64/node.exe" -d "${CACHE}/tmp"
cp "${CACHE}/tmp/node-${NODE_VER}-win-x64/node.exe" "${PKG}/node.exe"
rm -rf "${CACHE:?}/tmp"

echo "==> 5/6 启动脚本与说明"
# 文件名与批处理内容一律 ASCII：Windows 自带解压按 OEM 代码页处理中文名，
# 在 mac 上打的包解出来常常全是乱码（实测 zip 列表已乱）。中文说明放 README.txt。
cat > "${PKG}/start.bat" <<'BAT'
@echo off
cd /d "%~dp0"
start "" /b cmd /c "timeout /t 2 >nul & start http://127.0.0.1:5178"
"%~dp0node.exe" "%~dp0server.mjs"
echo.
echo Server stopped. Press any key to close.
pause >nul
BAT

cat > "${PKG}/start-lan.bat" <<'BAT'
@echo off
cd /d "%~dp0"
"%~dp0node.exe" "%~dp0server.mjs" --lan
echo.
echo Server stopped. Press any key to close.
pause >nul
BAT

python3 - "${PKG}/README.txt" <<'PYEOF'
import sys
text = """QDII 估值（Windows 绿色版）
==========================

怎么用
  双击 start.bat -> 浏览器自动打开 http://127.0.0.1:5178 -> 在页面里录入基金。
  关掉那个黑窗口就是停止服务。想放桌面就右键 start.bat 发快捷方式。

我的数据存在哪
  %APPDATA%\\QDII\\app.db
  一个 SQLite 文件，只在本机，不上传任何地方。
  备份就是复制这个文件；换电脑把它放到新机器的同一位置即可。

手机看
  双击 start-lan.bat。它会打开局域网监听并打印一个带口令的网址：
      http://192.168.x.x:5178/?token=xxxx
  手机连着同一个 Wi-Fi 打开那个链接，之后就记住（Cookie），不用再输。
  口令保存在 %APPDATA%\\QDII\\access-token.txt。
  注意：局域网模式下同一 Wi-Fi 的人只要有口令就能看你的持仓——
  在公司/咖啡店用完记得关掉窗口。

数据从哪来
  全部是公开行情接口（新浪、东财、腾讯、CNBC、Nasdaq），本程序无任何上报。
  QDII 净值 T+1 披露：页面上的百分比是当日涨跌估算，不是官方净值。

卸载
  删掉这个文件夹；想连数据一起删，再删 %APPDATA%\\QDII。
"""
open(sys.argv[1], 'w', encoding='utf-8-sig').write(text)
PYEOF

echo "==> 6/6 自检 + 压缩"
# 红线：包内不允许出现任何数据库/密钥文件
if find "${PKG}" -type f \( -name '*.db' -o -name '*.db-*' -o -name '*.env' -o -name 'access-token.txt' \) | grep -q .; then
  echo "!! 包里混进了数据文件，拒绝打包：" >&2
  find "${PKG}" -type f \( -name '*.db' -o -name '*.db-*' -o -name '*.env' -o -name 'access-token.txt' \) >&2
  exit 1
fi
cd "${OUT}"
rm -f "${ZIP}"
zip -qr "${ZIP}" "${NAME}"
echo
echo "完成：${ZIP}"
du -sh "${ZIP}" "${PKG}"
unzip -l "${ZIP}" | tail -12
