#!/bin/sh
# Builds "AI Flows.app": the small helper that shows macOS notifications for
# AI Flows. Needs Xcode (or its command line tools). install.sh calls this with
# the private install folder as $1; without it the app lands next to this file.
set -e
cd "$(dirname "$0")"

OUT="${1:-.}"
/bin/mkdir -p "$OUT"
APP="$OUT/AI Flows.app"
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

# Quick Look draws an SVG reliably at 1024 px only (smaller sizes come out
# with a margin), so render each drawing once at 1024 and scale down with sips.
# Only the <svg> element gets the new size: the shapes inside have width and
# height attributes too.
render1024() {
  sed -E "/<svg[ >]/ s/width=\"[0-9]+\" height=\"[0-9]+\"/width=\"1024\" height=\"1024\"/" "$1" > "$WORK/in.svg"
  qlmanage -t -s 1024 -o "$WORK" "$WORK/in.svg" >/dev/null 2>&1
  mv "$WORK/in.svg.png" "$2"
}
size() { sips -z "$2" "$2" "$1" --out "$3" >/dev/null; }

render1024 icon.svg "$WORK/master.png"
render1024 icon-32.svg "$WORK/small32.png"   # 16 and 32 px are drawn separately
render1024 icon-16.svg "$WORK/small16.png"

SET="$WORK/AppIcon.iconset"
size "$WORK/small16.png" 16 "$SET/icon_16x16.png"
size "$WORK/small32.png" 32 "$SET/icon_16x16@2x.png"
size "$WORK/small32.png" 32 "$SET/icon_32x32.png"
size "$WORK/small32.png" 64 "$SET/icon_32x32@2x.png"
size "$WORK/master.png" 128 "$SET/icon_128x128.png"
size "$WORK/master.png" 256 "$SET/icon_128x128@2x.png"
size "$WORK/master.png" 256 "$SET/icon_256x256.png"
size "$WORK/master.png" 512 "$SET/icon_256x256@2x.png"
size "$WORK/master.png" 512 "$SET/icon_512x512.png"
cp "$WORK/master.png" "$SET/icon_512x512@2x.png"
iconutil -c icns "$SET" -o "$APP/Contents/Resources/AppIcon.icns"

# A new build number each time, so macOS (Notification Center included) reads
# the icon again instead of showing a cached one.
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $(date +%s)" "$APP/Contents/Info.plist"
codesign --force --sign - "$APP"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP"
echo "Built: $APP"
