#!/bin/sh
# Builds "AI Flows.app": the small helper that shows macOS notifications for
# AI Flows. Needs Xcode (or its command line tools). Run again after changes.
set -e
cd "$(dirname "$0")"

APP="AI Flows.app"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$WORK/AppIcon.iconset"

xcrun swiftc -O -o "$APP/Contents/MacOS/AI Flows" main.swift

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>local.ai-flows.notifier</string>
  <key>CFBundleName</key><string>AI Flows</string>
  <key>CFBundleDisplayName</key><string>AI Flows</string>
  <key>CFBundleExecutable</key><string>AI Flows</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSUserNotificationAlertStyle</key><string>banner</string>
</dict>
</plist>
PLIST

# render <svg> <pixels> <output.png>: Quick Look draws an SVG at the size it declares.
render() {
  sed -E "s/width=\"[0-9]+\" height=\"[0-9]+\"/width=\"$2\" height=\"$2\"/" "$1" > "$WORK/in.svg"
  qlmanage -t -s "$2" -o "$WORK" "$WORK/in.svg" >/dev/null 2>&1
  mv "$WORK/in.svg.png" "$3"
}

SET="$WORK/AppIcon.iconset"
render icon-16.svg 16 "$SET/icon_16x16.png"        # 16 and 32 are drawn separately
render icon-32.svg 32 "$SET/icon_16x16@2x.png"
render icon-32.svg 32 "$SET/icon_32x32.png"
render icon.svg 64 "$SET/icon_32x32@2x.png"
render icon.svg 128 "$SET/icon_128x128.png"
render icon.svg 256 "$SET/icon_128x128@2x.png"
render icon.svg 256 "$SET/icon_256x256.png"
render icon.svg 512 "$SET/icon_256x256@2x.png"
render icon.svg 512 "$SET/icon_512x512.png"
render icon.svg 1024 "$SET/icon_512x512@2x.png"
iconutil -c icns "$SET" -o "$APP/Contents/Resources/AppIcon.icns"

codesign --force --sign - "$APP"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP"
echo "Gebouwd: $(pwd)/$APP"
