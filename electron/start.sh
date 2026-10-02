#!/bin/bash
# Launch the Voice Assistant Electron app directly (no npm overhead).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Kill any stale server from a previous session
STALE=$(lsof -ti:8765 2>/dev/null)
if [ -n "$STALE" ]; then
    kill $STALE 2>/dev/null
    sleep 1
fi

exec "$SCRIPT_DIR/node_modules/electron/dist/electron" \
  "$SCRIPT_DIR" \
  --no-sandbox
