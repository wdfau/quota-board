#!/bin/bash
set -euo pipefail
root="$(cd "$(dirname "$0")" && pwd)"
bundle="$root/额度看板.app"
resources="$bundle/Contents/Resources"
mkdir -p "$bundle/Contents/MacOS" "$resources"
vendor="$resources/vendor"
if [ -d "$root/vendor" ]; then
  mkdir -p "$vendor"
  cp -p "$root/vendor/"* "$vendor/"
fi
if [ ! -x "$vendor/CodexBarCLI" ]; then
  printf '缺少 CodexBarCLI，请保留原应用的 Contents/Resources/vendor 文件夹。\n' >&2
  exit 1
fi
stage="$(mktemp -d /private/tmp/quota-board-build.XXXXXX)"
trap 'rm -rf "$stage"' EXIT
/usr/bin/swiftc -swift-version 5 -O -module-cache-path /private/tmp/quota-board-module-cache \
  "$root/src/QuotaBoard.swift" "$root/src/AccountSetup.swift" -o "$stage/QuotaBoard" \
  -framework AppKit -framework SwiftUI
# 保留已有授权组件；源码更新时才重新编译。
if [ ! -x "$vendor/QuotaAccess" ] || [ "$root/src/QuotaAccess.swift" -nt "$vendor/QuotaAccess" ]; then
  /usr/bin/swiftc -O -module-cache-path /private/tmp/quota-board-module-cache "$root/src/QuotaAccess.swift" -o "$stage/QuotaAccess" -framework Security -lsqlite3
  /usr/bin/codesign --force --sign - --identifier local.quota-board.access "$stage/QuotaAccess"
  mv "$stage/QuotaAccess" "$vendor/QuotaAccess"
fi
mv "$stage/QuotaBoard" "$bundle/Contents/MacOS/QuotaBoard"
cp "$root/src/worker.py" "$resources/worker.py"
cp "$root/CodexBar-LICENSE" "$resources/CodexBar-LICENSE"
rm -f "$resources/BrandIcons/gemini.svg"
mkdir -p "$resources/BrandIcons"
cp "$root/src/BrandIcons/"* "$resources/BrandIcons/"
cat > "$bundle/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>QuotaBoard</string>
<key>CFBundleIdentifier</key><string>local.quota-board</string>
<key>CFBundleName</key><string>额度看板</string>
<key>CFBundleDisplayName</key><string>额度看板</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>1.5.5</string>
<key>CFBundleVersion</key><string>16</string>
<key>LSMinimumSystemVersion</key><string>26.0</string>
<key>LSUIElement</key><true/>
<key>NSHighResolutionCapable</key><true/>
<key>NSSupportsAutomaticTermination</key><false/>
</dict></plist>
PLIST
/usr/bin/codesign --force --sign - --identifier local.quota-board "$bundle"
/usr/bin/codesign --verify --deep --strict "$bundle"
printf '已生成菜单栏应用：%s\n' "$bundle"
