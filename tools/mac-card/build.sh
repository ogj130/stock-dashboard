#!/bin/bash
# 构建「美股基金估值卡片」.app —— 纯 Swift + AppKit + WKWebView，无第三方依赖
# 用法：./build.sh            产物在 dist/StockCard.app
#      ./build.sh run        构建后直接启动
set -euo pipefail

cd "$(dirname "$0")"

APP_NAME="StockCard"
BUNDLE="dist/${APP_NAME}.app"
BIN="${BUNDLE}/Contents/MacOS/${APP_NAME}"

rm -rf "$BUNDLE"
mkdir -p "$BUNDLE/Contents/MacOS" "$BUNDLE/Contents/Resources"

cat > "$BUNDLE/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>StockCard</string>
  <key>CFBundleDisplayName</key><string>基金估值卡片</string>
  <key>CFBundleIdentifier</key><string>local.stockmy.card</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <!-- 不占 Dock、不抢焦点，只留状态栏图标 -->
  <key>LSUIElement</key><true/>
  <key>NSAppTransportSecurity</key>
  <dict>
    <!-- 允许访问本机 http://127.0.0.1:5178 -->
    <key>NSAllowsLocalNetworking</key><true/>
  </dict>
</dict>
</plist>
PLIST

echo "编译 card.swift ..."
# -swift-version 5：避开 Swift 6 的严格并发检查（AppKit 回调都在主线程，没必要为它改造）
swiftc -O -swift-version 5 \
  -target arm64-apple-macosx13.0 \
  -framework Cocoa -framework WebKit \
  -o "$BIN" card.swift

chmod +x "$BIN"
# 临时签名，避免 Gatekeeper 对本地构建产物过度阻拦
codesign --force --sign - "$BUNDLE" 2>/dev/null || echo "（跳过签名）"

echo "完成：$BUNDLE"
du -sh "$BUNDLE"

if [[ "${1:-}" == "run" ]]; then
  echo "启动..."
  open "$BUNDLE"
fi
