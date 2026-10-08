#!/bin/sh
# Convenience wrapper: pull the latest code and restart. Same as running install.sh.
DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$DIR/install.sh" "$@"
