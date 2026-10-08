#!/bin/bash
# Registers the voice assistant launcher for the current install location.
# Linux: creates a .desktop file.  macOS: prints launch instructions.
# Run once after cloning or moving the project. Safe to re-run.

set -euo pipefail

INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

chmod +x "$INSTALL_DIR/launch.sh" "$INSTALL_DIR/electron/start.sh"

if [[ "$OSTYPE" == "darwin"* ]]; then
    echo "Voice Assistant installed at: $INSTALL_DIR"
    echo ""
    echo "To launch the Electron app:"
    echo "  cd $INSTALL_DIR/electron && npm start"
    echo ""
    echo "Or use the shell launcher:"
    echo "  $INSTALL_DIR/electron/start.sh"
else
    DESKTOP_DIR="$HOME/.local/share/applications"
    DESKTOP_FILE="$DESKTOP_DIR/voice-assistant.desktop"

    mkdir -p "$DESKTOP_DIR"

    cat > "$DESKTOP_FILE" << EOF
[Desktop Entry]
Version=1.0
Type=Application
Name=Voice Assistant
GenericName=Local AI Voice Assistant
Comment=Whisper STT · LM Studio LLM · Piper TTS — fully on-device
Exec=$INSTALL_DIR/electron/start.sh
Icon=$INSTALL_DIR/icon.svg
Terminal=false
Categories=Utility;AudioVideo;
Keywords=voice;assistant;AI;speech;microphone;
StartupNotify=true
StartupWMClass=voice-assistant
EOF

    update-desktop-database "$DESKTOP_DIR" 2>/dev/null || true

    echo "Installed: $DESKTOP_FILE"
    echo "Exec: $INSTALL_DIR/electron/start.sh"
    echo "Icon: $INSTALL_DIR/icon.svg"
fi
