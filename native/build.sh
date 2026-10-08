#!/bin/sh
# Builds "Vantage.app", a native WKWebView shell around the local server.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
APP="$DIR/Vantage.app"

echo "Building $APP …"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

xcrun swiftc -O -o "$APP/Contents/MacOS/Vantage" "$DIR/Vantage.swift" -framework Cocoa -framework WebKit -framework UserNotifications -framework IOKit -framework CoreGraphics

# App icon: prefer a checked-in source PNG; else render the procedural default.
if [ -f "$DIR/AppIcon.png" ]; then
  cp "$DIR/AppIcon.png" "$DIR/.icon-1024.png"
else
  xcrun swiftc -O -o "$DIR/.make-icon" "$DIR/make-icon.swift" -framework Cocoa
  "$DIR/.make-icon" "$DIR/.icon-1024.png"
fi
ICONSET="$DIR/.AppIcon.iconset"
rm -rf "$ICONSET"; mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -s format png -Z "$s" "$DIR/.icon-1024.png" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  d=$((s * 2))
  sips -s format png -Z "$d" "$DIR/.icon-1024.png" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"
rm -rf "$ICONSET" "$DIR/.icon-1024.png" "$DIR/.make-icon"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Vantage</string>
  <key>CFBundleDisplayName</key><string>Vantage</string>
  <key>CFBundleIdentifier</key><string>local.vantage.app</string>
  <key>CFBundleExecutable</key><string>Vantage</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.9.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleGetInfoString</key><string>Vantage 0.9.0 (Beta)</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSCameraUsageDescription</key><string>Vantage may use the camera for capture and scanning.</string>
  <key>NSMicrophoneUsageDescription</key><string>Vantage may use the microphone for voice features.</string>
</dict>
</plist>
PLIST

# Ad-hoc sign so it launches without Gatekeeper complaints.
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true
echo "Built $APP"
