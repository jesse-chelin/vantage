#!/bin/sh
# Vantage installer and updater.
#
# Fresh install (from your repo):
#   git clone git@github.com:jesse-chelin/vantage.git ~/Projects/vantage && ~/Projects/vantage/install.sh
# Public repo, truly one line:
#   curl -fsSL https://raw.githubusercontent.com/jesse-chelin/vantage/main/install.sh | sh
#
# Re-run the same command to update. Flags:
#   --native      build the native Mac app now (normally built from onboarding)
#   --uninstall   remove the login service
#
# Env overrides: VANTAGE_REPO, VANTAGE_DIR, PORT, NO_COLOR

set -e

LABEL="local.vantage"
PORT="${PORT:-8790}"
DEFAULT_DIR="$HOME/Projects/vantage"
REPO_URL="${VANTAGE_REPO:-}"

# --- pretty output ---------------------------------------------------------
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  R="$(printf '\033[0m')"
  B="$(printf '\033[1m')"
  D="$(printf '\033[2m')"
  RED="$(printf '\033[31m')"
  GRN="$(printf '\033[32m')"
  YEL="$(printf '\033[33m')"
  CYN="$(printf '\033[36m')"
else
  R=""; B=""; D=""; RED=""; GRN=""; YEL=""; CYN=""
fi

rule() { printf '%s\n' "${D}────────────────────────────────────────────────────${R}"; }
step() { printf '\n%s %s%s%s\n' "${CYN}▸${R}" "$B" "$1" "$R"; }
ok()   { printf '  %s %s\n' "${GRN}✓${R}" "$1"; }
warn() { printf '  %s %s\n' "${YEL}!${R}" "$1"; }
dim()  { printf '  %s\n' "${D}$1${R}"; }
key()  { printf '  %s%-12s%s %s\n' "$D" "$1" "$R" "$2"; }
say()  { printf '%s\n' "$1"; }

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
  printf '\n%s %s\n' "${GRN}✓${R}" "Removed the Vantage login service. Project files were left in place."
  exit 0
fi

printf '\n%s\n' "${B}Vantage · installer${R}"
rule
dim "$DIR"

# --- code ------------------------------------------------------------------
step "Checking code"
if [ ! -f "$DIR/server.js" ]; then
  command -v git >/dev/null 2>&1 || { printf '%s\n' "${RED}git is required.${R}"; exit 1; }
  if [ -z "$REPO_URL" ]; then
    printf '%s\n' "${RED}No local checkout found.${R} Set ${B}VANTAGE_REPO${R} to clone automatically, e.g.:"
    printf '%s\n' "  VANTAGE_REPO=git@github.com:jesse-chelin/vantage.git sh install.sh"
    exit 1
  fi
  dim "cloning $REPO_URL"
  mkdir -p "$(dirname "$DIR")"
  git clone "$REPO_URL" "$DIR"
  ok "cloned into $DIR"
elif [ -d "$DIR/.git" ]; then
  if git -C "$DIR" pull --ff-only >/dev/null 2>&1; then
    ok "updated from git"
  else
    warn "couldn't fast-forward, keeping local files"
  fi
else
  dim "local checkout"
fi

# --- node ------------------------------------------------------------------
step "Checking Node"
NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || { printf '%s\n' "${RED}Node.js 20+ is required:${R} https://nodejs.org"; exit 1; }
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || { printf '%s\n' "${RED}Node 20+ is required (found $("$NODE_BIN" -v)).${R}"; exit 1; }
NODE_DIR="$(dirname "$NODE_BIN")"
ok "node $("$NODE_BIN" -v)"

# --- dependencies ----------------------------------------------------------
step "Installing dependencies"
if [ -f "$DIR/package.json" ]; then
  (cd "$DIR" && npm install --silent --no-audit --no-fund) >/dev/null 2>&1 || true
  ok "npm packages ready"
else
  dim "no package.json"
fi

# --- login service (launchd) ----------------------------------------------
step "Installing the login service"
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
ok "$LABEL loaded"

# --- native app (optional, explicit) ---------------------------------------
# By default the native app is built from the onboarding "Run it as an app"
# step. Pass --native here only if you want it built straight away.
if [ "${1:-}" = "--native" ]; then
  step "Building the native Mac app"
  if (cd "$DIR/native" && ./build.sh); then
    ok "Vantage.app built"
  else
    warn "native build skipped"
  fi
fi

sleep 1
printf '\n%s\n' "${B}Vantage is ready${R}"
rule
key "Running" "http://localhost:$PORT"
key "Service" "$LABEL"
key "Logs" "/tmp/vantage.log"
key "Update" "$DIR/install.sh"
key "Uninstall" "$DIR/install.sh --uninstall"
printf '\n'
open "http://localhost:$PORT" 2>/dev/null || true
