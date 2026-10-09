#!/bin/sh
# Reset Vantage to a clean slate so the next install runs like a fresh one.
#
# Stops and removes the login service, wipes local data, drops the native app,
# and optionally clears macOS folder-access prompts. It does NOT reinstall: run
# install.sh yourself afterwards, exactly as a new user would, so the onboarding
# runs from scratch. Browser site permissions (notifications, persistent
# storage) are per-origin and cannot be scripted; the script prints what to clear.
#
#   ./reset.sh                 stop, wipe data, drop native app (no reinstall)
#   ./reset.sh --reinstall     also run install.sh when done
#   ./reset.sh --keep-data     keep settings/Touch ID/push, clear onboarding only
#   ./reset.sh --permissions   also reset macOS folder prompts (tccutil, all apps)
#   ./reset.sh --native        pass through to the installer (with --reinstall)
#
# Env overrides: VANTAGE_DIR, PORT, NO_COLOR

set -e

LABEL="local.vantage"
PORT="${PORT:-8790}"

KEEP_DATA=0
RESET_PERMS=0
REINSTALL=0
INSTALL_FLAGS=""

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
item() { printf '  %s\n' "$1"; }
dim()  { printf '  %s\n' "${D}$1${R}"; }
say()  { printf '%s\n' "$1"; }

for arg in "$@"; do
  case "$arg" in
    --keep-data) KEEP_DATA=1;;
    --permissions|--reset-permissions) RESET_PERMS=1;;
    --reinstall) REINSTALL=1;;
    --no-reinstall) REINSTALL=0;;
    --native) INSTALL_FLAGS="$INSTALL_FLAGS $arg";;
    *) printf '%s\n' "${RED}Unknown flag:${R} $arg"; exit 1;;
  esac
done

# Prefer the directory this script lives in (same rule as install.sh).
SCRIPT_DIR=""
case "$0" in
  */*) SCRIPT_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd)";;
esac
if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/server.js" ]; then
  DIR="$SCRIPT_DIR"
else
  DIR="${VANTAGE_DIR:-$HOME/Projects/vantage}"
fi

if [ ! -f "$DIR/server.js" ]; then
  printf '%s\n' "${RED}No Vantage checkout found at${R} $DIR ${D}(set VANTAGE_DIR)${R}"
  exit 1
fi

printf '\n%s\n' "${B}Vantage · reset${R}"
rule
dim "$DIR"

# --- stop the service ------------------------------------------------------
step "Stopping the login service"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || launchctl unload -w "$HOME/Library/LaunchAgents/$LABEL.plist" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
ok "service stopped and removed"

# KeepAlive can leave a process behind for a moment; make sure the port is free.
sleep 1
PIDS="$(lsof -ti "tcp:$PORT" 2>/dev/null || true)"
if [ -n "$PIDS" ]; then
  warn "killing leftover process on port $PORT ($PIDS)"
  kill $PIDS 2>/dev/null || true
fi

# --- wipe local data -------------------------------------------------------
step "Clearing local data"
if [ -d "$DIR/data" ]; then
  if [ "$KEEP_DATA" = "1" ]; then
    rm -f "$DIR/data/onboarding.json" "$DIR/data/inventory.json"
    ok "onboarding + inventory cleared (settings, Touch ID, push kept)"
  else
    BACKUP="$DIR/data.bak.$(date +%Y%m%d-%H%M%S)"
    mv "$DIR/data" "$BACKUP"
    ok "previous data moved to $(basename "$BACKUP")"
  fi
else
  dim "nothing to clear"
fi

# --- native app ------------------------------------------------------------
step "Removing the native app"
if [ -d "$DIR/native/Vantage.app" ]; then
  rm -rf "$DIR/native/Vantage.app"
  ok "Vantage.app removed"
else
  dim "not built"
fi

# --- macOS folder permissions ---------------------------------------------
if [ "$RESET_PERMS" = "1" ]; then
  step "Resetting macOS folder-access prompts"
  for svc in SystemPolicyDesktopFolder SystemPolicyDocumentsFolder SystemPolicyDownloadsFolder SystemPolicyAllFiles; do
    tccutil reset "$svc" >/dev/null 2>&1 || true
  done
  ok "permissions cleared"
  warn "this clears the prompt for every app, not just Vantage"
fi

# --- reinstall (opt in) or hand back to the user --------------------------
if [ "$REINSTALL" = "1" ]; then
  step "Reinstalling"
  # shellcheck disable=SC2086
  "$DIR/install.sh" $INSTALL_FLAGS
else
  step "Clean slate ready"
  printf '\n%s\n' "${B}Next step${R}"
  rule
  item "Run the installer like a new user:"
  item "  ${B}$DIR/install.sh${R}"
  printf '\n'
  dim "That starts the service and opens the dashboard; onboarding runs from scratch."
fi

# --- the bit a script can't do --------------------------------------------
printf '\n%s\n' "${B}One browser step${R} ${D}(can't be scripted)${R}"
rule
item "Clearing cookies alone does NOT reset permission grants, so notifications"
item "and persistent storage stay Allowed. Forget the site instead:"
printf '\n'
item "Zen / Firefox  History (⌘⇧H) → right-click ${B}localhost:$PORT${R} →"
item "               ${B}Forget About This Site${R}. That clears its data and permissions."
item "               Or in the site-info (padlock) panel, reset each permission to Ask."
item "               Notifications alone: Settings → Privacy & Security → Permissions"
item "               → Notifications → Settings → remove localhost:$PORT."
item "Chrome         ${D}chrome://settings/content/notifications${R} → remove localhost:$PORT,"
item "               then ${B}View permissions and data stored across sites${R} → localhost → delete."
item "Safari         Settings → Websites → Notifications → localhost:$PORT."
printf '\n'
dim "Firefox/Zen has no Idle Detection API, so that permission is never asked."
dim "Use http://localhost:$PORT (not 127.0.0.1), then reload to see the wizard."
