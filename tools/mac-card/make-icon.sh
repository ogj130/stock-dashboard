#!/bin/bash
# 从 icon.html 生成 StockCard.icns（需要 Google Chrome）
set -euo pipefail
cd "$(dirname "$0")"

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
[[ -x "$CHROME" ]] || { echo "需要 Google Chrome 来渲染 HTML"; exit 1; }

echo "渲染 1024×1024 ..."
"$CHROME" --headless --disable-gpu --hide-scrollbars \
  --default-background-color=00000000 --force-device-scale-factor=1 \
  --window-size=1024,1024 --screenshot="$PWD/icon-1024.png" \
  "file://$PWD/icon.html" 2>/dev/null

echo "生成 iconset ..."
rm -rf icon.iconset && mkdir -p icon.iconset
for s in 16 32 128 256 512; do
  sips -z "$s" "$s" icon-1024.png --out "icon.iconset/icon_${s}x${s}.png" >/dev/null
  sips -z $((s*2)) $((s*2)) icon-1024.png --out "icon.iconset/icon_${s}x${s}@2x.png" >/dev/null
done

iconutil -c icns icon.iconset -o StockCard.icns
echo "完成：StockCard.icns（$(du -h StockCard.icns | cut -f1)）"
