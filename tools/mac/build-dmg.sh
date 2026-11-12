#!/usr/bin/env bash
# 打一个 macOS arm64 的 DMG：
#
#   QDII 估值.app     自带 node（arm64）+ server.mjs + 前端；双击 → 起服务 → 开浏览器
#   StockCard.app     菜单栏卡片（可选，需要上面的服务在跑）
#   README.txt        安装与卸载说明
#
# 为什么要自带 node：服务端用 node:sqlite（内置 SQLite），这是 Node 22.5+ 才有的
# 内置模块；macOS 自带的 python/ruby 帮不上忙，用户机器上又没有 node。带一份
# ~110MB 的 arm64 node，换来「拖进 Applications 就能用」。
#
# 和 Windows 绿色版同一套红线：
#   · 只拷 dist/ 与 server.mjs，绝不碰 data/、*.db、*.env
#   · 打完检查包里没有数据库/口令文件
#   · 用包里的 node 真起一次服务，断言 / 与静态资源 200（404 不能静默发出去）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="${ROOT}/dist-mac"
NODE_VER="${NODE_VER:-v24.18.0}"
ARCH="${ARCH:-arm64}"
APP_NAME="QDII 估值"
NAME="QDII-${NODE_VER#v}-mac-${ARCH}"
STAGE="${OUT}/stage"
APP="${STAGE}/${APP_NAME}.app"
RES="${APP}/Contents/Resources"
DMG="${OUT}/${NAME}.dmg"

step() { printf '\n==> %s\n' "$*"; }

step "1/8 清理"
rm -rf "${OUT:?}"
mkdir -p "${STAGE}" "${APP}/Contents/MacOS" "${RES}"

step "2/8 构建前端"
cd "${ROOT}"
pnpm exec vite build >/dev/null
cp -R "${ROOT}/dist" "${RES}/dist"

step "3/8 打包服务端 bundle"
node "${ROOT}/tools/win/build-server.mjs" "${RES}/server.mjs"

step "4/8 取 macOS node（${NODE_VER} ${ARCH}）"
CACHE="${ROOT}/.cache"
mkdir -p "${CACHE}"
TARBALL="${CACHE}/node-${NODE_VER}-darwin-${ARCH}.tar.gz"
if [ ! -f "${TARBALL}" ]; then
  curl -fL --retry 3 -o "${TARBALL}" \
    "https://nodejs.org/dist/${NODE_VER}/node-${NODE_VER}-darwin-${ARCH}.tar.gz"
fi
rm -rf "${CACHE:?}/tmp"
mkdir -p "${CACHE}/tmp"
tar -xzf "${TARBALL}" -C "${CACHE}/tmp" "node-${NODE_VER}-darwin-${ARCH}/bin/node"
cp "${CACHE}/tmp/node-${NODE_VER}-darwin-${ARCH}/bin/node" "${RES}/node"
chmod +x "${RES}/node"
rm -rf "${CACHE:?}/tmp"

step "5/8 生成 .app 外壳"
cp "${ROOT}/tools/mac-card/StockCard.icns" "${RES}/AppIcon.icns"

cat > "${APP}/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>QDII</string>
  <key>CFBundleName</key><string>${APP_NAME}</string>
  <key>CFBundleDisplayName</key><string>${APP_NAME}</string>
  <key>CFBundleIdentifier</key><string>local.stockmy.app</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <!-- 它只是个启动器：起服务、开浏览器、退出，不占 Dock -->
  <key>LSUIElement</key><true/>
  <key>NSAppTransportSecurity</key>
  <dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict>
</plist>
PLIST

cat > "${APP}/Contents/MacOS/QDII" <<'LAUNCHER'
#!/bin/bash
# 启动器：确保本地服务在跑，然后打开浏览器。
#
# 已有一个服务在 5178 上时直接复用（开发机上的 launchd 服务不会被这份 DMG 顶掉）。
# 服务日志写 ~/Library/Logs/qdii-app.log；数据库在 ~/Library/Application Support/QDII。
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
RES="$(cd "$HERE/../Resources" && pwd)"
PORT="${PORT:-5178}"
LOG="${HOME}/Library/Logs/qdii-app.log"

mkdir -p "${HOME}/Library/Logs" "${HOME}/Library/Application Support/QDII"
cd "${HOME}"

healthy() {
  /usr/bin/curl -sf -o /dev/null "http://127.0.0.1:${PORT}/api/health" 2>/dev/null
}

if ! healthy; then
  # nohup + disown：启动器退出后服务继续活着，关浏览器也不会停
  nohup "${RES}/node" "${RES}/server.mjs" >>"${LOG}" 2>&1 &
  disown || true
  for _ in $(seq 1 80); do
    healthy && break
    /bin/sleep 0.25
  done
fi

if [ "${QDII_NO_OPEN:-0}" = "1" ]; then
  exit 0
fi
/usr/bin/open "http://127.0.0.1:${PORT}"
LAUNCHER
chmod +x "${APP}/Contents/MacOS/QDII"

step "6/8 构建菜单栏卡片"
if command -v swiftc >/dev/null 2>&1; then
  ( cd "${ROOT}/tools/mac-card" && ./build.sh >/tmp/qdii-card-build.log 2>&1 ) || {
    echo "!! 卡片构建失败，见 /tmp/qdii-card-build.log" >&2; exit 1; }
  cp -R "${ROOT}/tools/mac-card/dist/StockCard.app" "${STAGE}/StockCard.app"
else
  echo "（本机没有 swiftc，跳过菜单栏卡片）"
fi

step "7/8 签名 + 冒烟自检"
codesign --force --deep --sign - "${APP}" 2>/dev/null || echo "（跳过签名）"
if [ -d "${STAGE}/StockCard.app" ]; then
  codesign --force --deep --sign - "${STAGE}/StockCard.app" 2>/dev/null || true
fi

# 用包里的 node 真起一次服务：只看「构建成功」发现不了 / 404 这种事故
SMOKE_TMP="$(mktemp -d)"
SMOKE_PORT="${SMOKE_PORT:-$((5500 + RANDOM % 400))}"
SMOKE_PID=""
cleanup_smoke() {
  if [ -n "${SMOKE_PID}" ] && kill -0 "${SMOKE_PID}" 2>/dev/null; then
    kill "${SMOKE_PID}" 2>/dev/null || true
    wait "${SMOKE_PID}" 2>/dev/null || true
  fi
  rm -rf "${SMOKE_TMP}"
}
trap cleanup_smoke EXIT
(
  cd "${HOME}"
  exec env DB_PATH="${SMOKE_TMP}/smoke.db" PORT="${SMOKE_PORT}" "${RES}/node" "${RES}/server.mjs"
) >"${SMOKE_TMP}/smoke.log" 2>&1 &
SMOKE_PID=$!

code=000
for _ in $(seq 1 40); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${SMOKE_PORT}/api/health" || true)
  [ "${code}" = "200" ] && break
  sleep 0.25
done
if [ "${code}" != "200" ]; then
  echo "!! 服务没起来（/api/health = ${code}），冒烟日志：" >&2
  tail -20 "${SMOKE_TMP}/smoke.log" >&2
  exit 1
fi

root_code=$(curl -s -o "${SMOKE_TMP}/index.html" -w '%{http_code}' "http://127.0.0.1:${SMOKE_PORT}/" || true)
if [ "${root_code}" != "200" ] || ! grep -q 'id="root"' "${SMOKE_TMP}/index.html"; then
  echo "!! 首页不可用（GET / = ${root_code}），冒烟日志：" >&2
  tail -20 "${SMOKE_TMP}/smoke.log" >&2
  exit 1
fi
asset=$(grep -o '/assets/[^"]*\.js' "${SMOKE_TMP}/index.html" | head -1 || true)
asset_code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${SMOKE_PORT}${asset}" || true)
if [ -z "${asset}" ] || [ "${asset_code}" != "200" ]; then
  echo "!! 静态资源不可用（${asset:-index.html 里没有 /assets/*.js} = ${asset_code}）" >&2
  tail -20 "${SMOKE_TMP}/smoke.log" >&2
  exit 1
fi
cleanup_smoke
trap - EXIT
echo "    GET / 200、${asset} 200、/api/health 200"

# 红线：包内不允许出现数据库/密钥
if find "${STAGE}" -type f \( -name '*.db' -o -name '*.db-*' -o -name '*.env' -o -name 'access-token.txt' \) | grep -q .; then
  echo "!! 包里混进了数据文件，拒绝打包：" >&2
  find "${STAGE}" -type f \( -name '*.db' -o -name '*.db-*' -o -name '*.env' -o -name 'access-token.txt' \) >&2
  exit 1
fi

step "8/8 组装 DMG"
ln -s /Applications "${STAGE}/Applications"
cat > "${STAGE}/README.txt" <<'EOF'
QDII 估值（macOS arm64）
=======================

安装
  把「QDII 估值」拖到 Applications。
  首次打开若提示「无法验证开发者」：右键 → 打开 → 仍要打开；
  或者先执行：xattr -dr com.apple.quarantine "/Applications/QDII 估值.app"

怎么用
  打开 QDII 估值 → 后台起本地服务并打开 http://127.0.0.1:5178
  关浏览器不会停服务；停止：pkill -f 'QDII 估值.app/Contents/Resources/server.mjs'
  日志：~/Library/Logs/qdii-app.log
  数据：~/Library/Application Support/QDII/app.db（复制即备份，只在本机）

菜单栏卡片（可选）
  先打开一次 QDII 估值让服务起来，再打开 StockCard.app。
  卡片常驻菜单栏；右键菜单里可退出、复位位置、打开完整页面。

注意
  未签名也未公证，首次打开需要右键打开。数据全部留在本机，程序不上报任何东西。
EOF

rm -f "${DMG}"
# 首选 UDZO（压缩）。沙箱/无挂载权限的环境里 hdiutil create 会失败（它内部要挂载临时镜像），
# 退回 makehybrid —— 不挂载、直接拼一个 HFS 镜像，代价是没压缩。
if hdiutil create -volname "${APP_NAME}" -srcfolder "${STAGE}" -ov -format UDZO "${DMG}" >/dev/null 2>&1; then
  :
else
  echo "（hdiutil create 不可用，退回 makehybrid；本地调试用，CI 上会走压缩）"
  hdiutil makehybrid -hfs -hfs-volume-name "${APP_NAME}" -o "${DMG}" "${STAGE}" >/dev/null
fi
echo
echo "完成：${DMG}"
du -sh "${DMG}" "${APP}"
