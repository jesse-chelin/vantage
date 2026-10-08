#!/bin/sh
# Update Vantage in place.
#
# Uses the same code path as the in-app updater (the toolbar Update button), so
# the terminal and the app always behave alike. Flags: --check, --native, --json.
#
#   ~/Projects/vantage/update.sh
#   ~/Projects/vantage/update.sh --check     # exit 10 if an update is waiting
#   ~/Projects/vantage/update.sh --native    # also rebuild the native Mac app

set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
NODE_BIN="$(command -v node || true)"

if [ -z "$NODE_BIN" ]; then
  echo "Node.js 20+ is required: https://nodejs.org"
  exit 1
fi

if [ ! -f "$DIR/bin/vantage-update.js" ]; then
  # Very old checkout without the shared updater: fall back to the installer.
  exec "$DIR/install.sh" "$@"
fi

exec "$NODE_BIN" "$DIR/bin/vantage-update.js" "$@"
