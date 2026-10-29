#!/bin/bash
# Build / refresh the Mac app from this source tree.
#   ./build_mac.sh   -> updates ../Paper Reader.app (created from macos/ the first time) and writes a versioned zip next to it
# After building, double-click the app — the launcher notices the new version and swaps it in.
set -e
cd "$(dirname "$0")"
V=$(cat VERSION)
APP="${APP:-../Paper Reader.app}"
[ -d "$APP/Contents" ] || cp -R "macos/Paper Reader.app" "$APP"
OUT_DIR="$(cd "$(dirname "$APP")" && pwd)"
sed -i.bak "s|<key>CFBundleVersion</key><string>[^<]*</string>|<key>CFBundleVersion</key><string>$V</string>|; s|<key>CFBundleShortVersionString</key><string>[^<]*</string>|<key>CFBundleShortVersionString</key><string>$V</string>|" "$APP/Contents/Info.plist" && rm -f "$APP/Contents/Info.plist.bak"
rm -rf "$APP/Contents/Resources/app" && mkdir -p "$APP/Contents/Resources/app"
cp -R server.py claude_code.py lookup.py lifecycle.py childguard.py static tests requirements.txt README.md VERSION launch.sh "$APP/Contents/Resources/app/"
cp "macos/Paper Reader.app/Contents/MacOS/PaperReader" "$APP/Contents/MacOS/PaperReader"
for ic in AppIcon.icns AppIcon.png; do cp "macos/Paper Reader.app/Contents/Resources/$ic" "$APP/Contents/Resources/$ic"; done
find "$APP" -name __pycache__ -type d -exec rm -rf {} + 2>/dev/null || true
find "$APP" -name .DS_Store -delete 2>/dev/null || true
chmod +x "$APP/Contents/MacOS/"* "$APP/Contents/Resources/app/launch.sh"
touch "$APP"   # make Finder pick up the icon
echo "app updated: $APP (v$V)"
if command -v zip >/dev/null 2>&1; then
  OUT="$OUT_DIR/Paper Reader v$V.zip"; rm -f "$OUT"
  ( cd "$OUT_DIR"
    items=("$(basename "$APP")")
    for f in *.command README-FIRST.txt; do [ -e "$f" ] && items+=("$f"); done
    zip -qr "$OUT" "${items[@]}" )
  echo "zip: $OUT"
fi
