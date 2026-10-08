#!/bin/sh
# Vantage installer and updater.
#
# Fresh install (from your repo):
#   git clone <your-repo-url> ~/Projects/vantage && ~/Projects/vantage/install.sh
# Public repo, truly one line:
#   curl -fsSL https://raw.githubusercontent.com/<you>/vantage/main/install.sh | sh
#
# Re-run the same command to update. Flags:
#   --native      also build the native Mac app (default: build if Xcode tools exist)
#   --no-native   skip the native app
#   --uninstall   remove the login service
#
# Env overrides: VANTAGE_REPO, VANTAGE_DIR, PORT

set -e

LABEL="local.vantage"
PORT="${PORT:-8790}"
DEFAULT_DIR="$HOME/Projects/vantage"
REPO_URL="${VANTAGE_REPO:-}"

say() { printf '%s\n' "$1"; }

# Prefer the directory this script lives in (so a cloned repo updates in place).
SCRIPT_DIR=""
case "$0" in
  */*) SCRIPT_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd)";;
esac
if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/server.js" ]; then
  DIR="$SCRIPT_DIR"
else
  DIR="${VANTAGE_DIR:-$DEFAULT_DIR}"
fi

if [ "${1:-}" = "--uninstall" ]; then
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || launchctl unload -w "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  say "Removed the Vantage login service. Project files were left in place."
  exit 0
fi

say "Vantage installer"
say ""

# --- code ------------------------------------------------------------------
if [ ! -f "$DIR/server.js" ]; then
  command -v git >/dev/null 2>&1 || { say "git is required."; exit 1; }
  if [ -z "$REPO_URL" ]; then
    say "No local checkout found. Set VANTAGE_REPO to clone automatically, e.g.:"
    say "  VANTAGE_REPO=git@github.com:you/vantage.git sh install.sh"
    exit 1
  fi
  say "Cloning $REPO_URL"
  mkdir -p "$(dirname "$DIR")"
  git clone "$REPO_URL" "$DIR"
elif [ -d "$DIR/.git" ]; then
  say "Updating $DIR"
  git -C "$DIR" pull --ff-only || say "(couldn't fast-forward, keeping local files)"
fi

# --- node ------------------------------------------------------------------
NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || { say "Node.js 20+ is required: https://nodejs.org"; exit 1; }
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || { say "Node 20+ is required (found $("$NODE_BIN" -v))."; exit 1; }
NODE_DIR="$(dirname "$NODE_BIN")"

# --- dependencies ----------------------------------------------------------
if [ -f "$DIR/package.json" ]; then
  (cd "$DIR" && npm install --silent --no-audit --no-fund) >/dev/null 2>&1 || true
fi

# --- login service (launchd) ----------------------------------------------
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$NODE_BIN</string><string>$DIR/server.js</string></array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$NODE_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>PORT</key><string>$PORT</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>/tmp/vantage.log</string>
  <key>StandardErrorPath</key><string>/tmp/vantage.err</string>
</dict>
</plist>
PLIST_EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || launchctl load -w "$PLIST" 2>/dev/null || true
launchctl kickstart -k "gui/$(id -u)/$LABEL" 2>/dev/null || true

# --- native app (optional) -------------------------------------------------
build_native=0
[ "${1:-}" = "--native" ] && build_native=1
if [ "${1:-}" != "--no-native" ] && command -v xcrun >/dev/null 2>&1 && xcrun --find swiftc >/dev/null 2>&1; then
  build_native=1
fi
if [ "$build_native" = "1" ]; then
  say "Building the native Mac app"
  (cd "$DIR/native" && ./build.sh) || say "(native build skipped)"
fi

sleep 1
say ""
say "Vantage is running:  http://localhost:$PORT"
say "Login service:       $LABEL"
say "Logs:                /tmp/vantage.log"
say "Update:              $DIR/install.sh"
say "Uninstall:           $DIR/install.sh --uninstall"
open "http://localhost:$PORT" 2>/dev/null || true
