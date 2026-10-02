#!/bin/bash
# Voice Assistant launcher — starts everything, opens browser, cleans up on close.

set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV="$APP_DIR/venv"
GRADIO_PORT=7860
LMSTUDIO_BIN="$HOME/lmstudio/LM-Studio-0.4.12/lm-studio"
LOG="$APP_DIR/app.log"

# ── 1. Start LM Studio if not already running ─────────────────────────────────
if ! pgrep -f "LM-Studio" > /dev/null 2>&1; then
    echo "Starting LM Studio..."
    "$LMSTUDIO_BIN" &
    sleep 3
fi

# ── 2. Start Gradio app (using venv) ─────────────────────────────────────────
echo "Starting voice assistant..." > "$LOG"
cd "$APP_DIR"
"$VENV/bin/python3" app.py >> "$LOG" 2>&1 &
GRADIO_PID=$!

# ── 3. Wait for Gradio to be ready (up to 30s) ───────────────────────────────
for i in $(seq 1 30); do
    sleep 1
    if curl -sf "http://localhost:$GRADIO_PORT" > /dev/null 2>&1; then
        break
    fi
    if ! kill -0 $GRADIO_PID 2>/dev/null; then
        notify-send "Voice Assistant" "Failed to start. Check $LOG" 2>/dev/null || true
        exit 1
    fi
done

# ── 4. Open browser in standalone app window ──────────────────────────────────
BROWSER_URL="http://localhost:$GRADIO_PORT"
BROWSER_PID=""

for browser in chromium-browser chromium google-chrome google-chrome-stable; do
    if command -v "$browser" > /dev/null 2>&1; then
        "$browser" \
            --app="$BROWSER_URL" \
            --no-first-run \
            --disable-extensions \
            --new-window \
            --window-size=960,700 \
            --user-data-dir="$APP_DIR/.chrome-profile" \
            --allow-insecure-localhost \
            2>/dev/null &
        BROWSER_PID=$!
        break
    fi
done

if [ -z "$BROWSER_PID" ]; then
    xdg-open "$BROWSER_URL"
    wait $GRADIO_PID
else
    wait $BROWSER_PID 2>/dev/null || true
fi

# ── 5. Clean up when browser closes ──────────────────────────────────────────
echo "Shutting down voice assistant..."
kill $GRADIO_PID 2>/dev/null || true
