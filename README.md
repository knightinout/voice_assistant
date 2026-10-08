# Voice Assistant

A fully on-device voice assistant using Whisper STT, LM Studio (local LLM), and Piper TTS. Three interfaces available: terminal, Gradio web UI, and Electron desktop app.

---

## Pipeline

```
Mic → Whisper (faster-whisper) → LM Studio → Piper TTS → Speaker
```

All processing is local. No cloud services.

---

## Prerequisites

- **LM Studio** running with a model loaded and Local Server started (`http://localhost:1234/v1`)
- Python 3.12 venv at `venv/` (already set up)
- Node.js v22+ / npm 10+ (for Electron app only)

---

## Interfaces

### 1. Terminal (recommended, most reliable)

```bash
cd ~/voice_assistant
venv/bin/python listen.py
```

Press `Enter` to start recording, `Enter` again to stop. `Ctrl+C` to quit.

### 2. Electron Desktop App

```bash
cd ~/voice_assistant/electron
npm start
```

- Opens a native window — no browser mic permission issues
- FastAPI backend starts automatically on port `8765`
- Click the mic button to record, click again to stop
- Voice can be switched mid-conversation via the dropdown
- Closing the window kills the Python server

### 3. Gradio Web UI (legacy, has mic permission issues)

```bash
cd ~/voice_assistant
./launch.sh
```

Opens at `http://localhost:7860`. May have microphone permission problems in some browsers.

---

## Voices

Voice models live in `~/.local/share/piper/`:

| File | Description |
|------|-------------|
| `en_GB-jenny_dioco-medium.onnx` | British female, medium quality (default) |
| `en_US-lessac-medium.onnx` | American male, medium quality |
| `en_US-amy-low.onnx` | American female, low quality (fastest) |

To add more voices, drop `.onnx` + `.onnx.json` pairs into `~/.local/share/piper/` and restart the app.

---

## File Structure

```
voice_assistant/
├── listen.py               Terminal interface
├── app.py                  Gradio web UI
├── server.py               FastAPI backend (port 8765)
├── launch.sh               Gradio launcher script
├── *.onnx / *.onnx.json    Piper voice models
├── venv/                   Python virtualenv
└── electron/
    ├── package.json
    ├── main.js             Electron main process
    ├── preload.js          Context bridge
    └── renderer/
        ├── index.html
        ├── style.css
        └── app.js
```

---

## RAG — Document Q&A

The Electron app supports attaching documents so the assistant can answer questions about them.

**Supported formats:** PDF (`.pdf`), plain text (`.txt`), Markdown (`.md`)

**How it works:**
1. Click **+ Attach** in the document panel (below the status bar)
2. Select one or more files — they are chunked (~400 words/chunk) and embedded via LM Studio
3. On every voice query, the transcript is embedded and the top matching chunks are retrieved and injected into the system prompt
4. Bot replies show a `📎 From: filename.pdf` hint when documents were used
5. Documents persist between sessions (`~/.local/share/voice_assistant_rag/`)
6. Click **×** on a document chip to remove it

**Requirements:**
- An **embedding model** must be loaded in LM Studio alongside your chat model (e.g. `nomic-embed-text`, `text-embedding-nomic-embed-text-v1.5`)
- `pymupdf` must be installed in the venv (already done): `venv/bin/pip install pymupdf`

**Tuning (server.py):**
| Constant | Default | Effect |
|----------|---------|--------|
| `RAG_K` | `3` | Max chunks retrieved per query |
| `RAG_THRESHOLD` | `0.25` | Min cosine similarity — raise to be stricter |

---

## API Endpoints (server.py)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | LM Studio status and loaded model name |
| POST | `/upload` | Multipart file → chunk, embed, store |
| GET | `/documents` | List stored documents |
| DELETE | `/documents/{id}` | Remove a document |
| GET | `/voices` | List available voices with current selection |
| POST | `/voice` | `{"voice_id": "/path/to/voice.onnx"}` — switch voice |
| POST | `/transcribe?sample_rate=N` | Raw Float32LE PCM body → `{"transcript": "..."}` |
| POST | `/chat` | `{transcript, history}` → `{reply, audio_b64}` |

Run the server standalone:

```bash
cd ~/voice_assistant
venv/bin/python -m uvicorn server:app --host 127.0.0.1 --port 8765
```

---

## Configuration

Key constants at the top of each script:

| Setting | Default | Files |
|---------|---------|-------|
| Whisper model | `base` | `listen.py`, `server.py`, `app.py` |
| Default voice | `en_GB-jenny_dioco-medium` | `listen.py`, `server.py` |
| LM Studio URL | `http://localhost:1234/v1` | all |
| FastAPI port | `8765` | `server.py`, `electron/main.js`, `electron/preload.js` |
| Gradio port | `7860` | `app.py`, `launch.sh` |

---

## Git Workflow

- **`main`** — stable releases only. Do not push directly.
- **`dev`** — integration branch. All work merges here first.
- Create feature branches off `dev` (e.g. `feature/new-voice`, `fix/mic-bug`)
- Open PRs into `dev`. When `dev` is stable, merge into `main`.
- Tag releases on `main`: `git tag v1.0`

---

## Troubleshooting

**LM Studio not reachable**
Open LM Studio → load a model → click *Start Server* in the Local Server tab.

**Electron window stuck on "Connecting…"**
Check the terminal for `[py]`-prefixed output. The Python server may still be loading Whisper (~5s on first start).

**No audio playback in Electron**
Ensure the system audio output is not muted. The WAV is played via the Web Audio API inside the renderer.

**`ModuleNotFoundError` on server start**
Make sure you're using the venv Python: `venv/bin/python`, not the system Python.

**Port 8765 already in use**
```bash
kill $(lsof -ti:8765)
```
