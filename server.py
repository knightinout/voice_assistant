#!/usr/bin/env python3
"""FastAPI backend for the Electron voice assistant."""

import base64
import glob
import io
import json
import os
import re
import shutil
import subprocess
import uuid
import wave
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path

import numpy as np
import psutil
import scipy.signal
from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from faster_whisper import WhisperModel
from openai import OpenAI
from piper.voice import PiperVoice

try:
    import fitz  # pymupdf
    PYMUPDF_OK = True
except ImportError:
    PYMUPDF_OK = False

# ── Config ────────────────────────────────────────────────────────────────────
WHISPER_MODEL  = "base"
VOICE_DIR      = os.path.expanduser("~/.local/share/piper")
DEFAULT_VOICE  = os.path.join(VOICE_DIR, "en_GB-jenny_dioco-medium.onnx")
LM_STUDIO_URL  = "http://localhost:1234/v1"
RAG_DIR        = Path.home() / ".local" / "share" / "voice_assistant_rag"
NOTES_DIR      = Path.home() / "VoiceNotes"
RAG_K          = 3
RAG_THRESHOLD  = 0.25
AGENT_MAX_ITER = 8   # max tool-call rounds before forcing final answer

SYSTEM_PROMPT = (
    "You are a helpful voice assistant with access to tools for managing files, "
    "checking system information, creating notes, and searching packages. "
    "Give concise spoken responses — avoid markdown, bullet points, and code blocks. "
    "When asked to install or remove software, use apt_search to find the right package "
    "name, then advise the user to run the command themselves — do not attempt to execute "
    "sudo commands. Always confirm what you did after completing a task."
)
# ─────────────────────────────────────────────────────────────────────────────


# ── Vector store ──────────────────────────────────────────────────────────────

class VectorStore:
    """Persistent vector store: one JSON file per document."""

    def __init__(self, directory: Path):
        self.dir = directory
        self.dir.mkdir(parents=True, exist_ok=True)
        self.docs: dict[str, dict] = {}
        self._load_all()

    def _load_all(self):
        for f in sorted(self.dir.glob("*.json")):
            try:
                with open(f) as fp:
                    self.docs[f.stem] = json.load(fp)
            except Exception:
                pass

    def add(self, doc_id: str, filename: str, chunks: list[str], embeddings: list[list[float]]):
        data = {"filename": filename,
                "chunks": [{"text": t, "embedding": e} for t, e in zip(chunks, embeddings)]}
        self.docs[doc_id] = data
        with open(self.dir / f"{doc_id}.json", "w") as f:
            json.dump(data, f)

    def remove(self, doc_id: str) -> bool:
        if doc_id not in self.docs:
            return False
        del self.docs[doc_id]
        p = self.dir / f"{doc_id}.json"
        if p.exists():
            p.unlink()
        return True

    def query(self, embedding: list[float], k: int = RAG_K) -> list[dict]:
        q = np.array(embedding, dtype=np.float32)
        q_norm = np.linalg.norm(q)
        if q_norm > 0:
            q /= q_norm
        results = []
        for doc in self.docs.values():
            for chunk in doc["chunks"]:
                e = np.array(chunk["embedding"], dtype=np.float32)
                e_norm = np.linalg.norm(e)
                if e_norm > 0:
                    e /= e_norm
                score = float(q @ e)
                if score >= RAG_THRESHOLD:
                    results.append({"text": chunk["text"], "filename": doc["filename"], "score": score})
        results.sort(key=lambda x: x["score"], reverse=True)
        return results[:k]

    def list_docs(self) -> list[dict]:
        return [{"doc_id": k, "filename": v["filename"], "chunks": len(v["chunks"])}
                for k, v in self.docs.items()]

    @property
    def is_empty(self) -> bool:
        return not self.docs


# ── Agent tools ───────────────────────────────────────────────────────────────

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "get_datetime",
            "description": "Returns the current date, time, and day of the week.",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_system_info",
            "description": "Returns CPU usage percentage, RAM usage, and disk space.",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_directory",
            "description": "Lists files and folders in a directory (home directory only).",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string",
                             "description": "Directory to list, e.g. '~', '~/Documents', '~/Downloads'"}
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_files",
            "description": "Search for files matching a pattern in the home directory.",
            "parameters": {
                "type": "object",
                "properties": {
                    "pattern": {"type": "string",
                                "description": "Filename glob pattern, e.g. '*.pdf', 'report*'"},
                    "directory": {"type": "string",
                                  "description": "Directory to search (default: home)"},
                },
                "required": ["pattern"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "Read a text or markdown file from the home directory.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Full path to the file"}
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "apt_search",
            "description": "Search available apt packages by name or keyword.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Package name or keyword"}
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_installed",
            "description": "List installed apt packages, optionally filtered by name.",
            "parameters": {
                "type": "object",
                "properties": {
                    "filter": {"type": "string",
                               "description": "Optional package name substring filter"}
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "create_note",
            "description": "Create or overwrite a markdown note in ~/VoiceNotes/.",
            "parameters": {
                "type": "object",
                "properties": {
                    "filename": {"type": "string",
                                 "description": "Note filename without extension, e.g. 'meeting-notes'"},
                    "content":  {"type": "string", "description": "Markdown content of the note"},
                },
                "required": ["filename", "content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "move_file",
            "description": (
                "Move or rename a file within the home directory. "
                "Will not overwrite an existing file at the destination."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "source":      {"type": "string", "description": "Source file path"},
                    "destination": {"type": "string", "description": "Destination path"},
                },
                "required": ["source", "destination"],
            },
        },
    },
]

# Human-readable labels for the UI
TOOL_LABELS: dict[str, str] = {
    "get_datetime":   "checking date & time",
    "get_system_info":"reading system info",
    "list_directory": "listing directory",
    "search_files":   "searching files",
    "read_file":      "reading file",
    "apt_search":     "searching packages",
    "list_installed": "listing installed packages",
    "create_note":    "creating note",
    "move_file":      "moving file",
}


def _safe_path(raw: str) -> Path | None:
    """Resolve path; return None if outside home."""
    try:
        p = Path(raw).expanduser().resolve()
        if str(p).startswith(str(Path.home().resolve())):
            return p
    except Exception:
        pass
    return None


def execute_tool(name: str, args: dict) -> str:
    try:
        if name == "get_datetime":
            return datetime.now().strftime("%A, %B %d %Y, %I:%M %p")

        elif name == "get_system_info":
            cpu  = psutil.cpu_percent(interval=0.5)
            mem  = psutil.virtual_memory()
            disk = psutil.disk_usage("/")
            return (
                f"CPU {cpu:.0f}% | "
                f"RAM {mem.used/1e9:.1f}/{mem.total/1e9:.1f} GB ({mem.percent:.0f}%) | "
                f"Disk {disk.used/1e9:.0f}/{disk.total/1e9:.0f} GB ({disk.percent:.0f}% used)"
            )

        elif name == "list_directory":
            p = _safe_path(args.get("path", "~"))
            if p is None:
                return "Error: path must be within your home directory."
            if not p.exists():
                return f"Directory not found: {p}"
            if not p.is_dir():
                return f"Not a directory: {p}"
            items = sorted(p.iterdir(), key=lambda x: (not x.is_dir(), x.name.lower()))
            lines = [("📁 " if i.is_dir() else "📄 ") + i.name for i in items[:60]]
            return "\n".join(lines) or "Empty directory."

        elif name == "search_files":
            pattern   = args.get("pattern", "*")
            directory = _safe_path(args.get("directory", "~"))
            if directory is None:
                return "Error: directory must be within home."
            matches = list(directory.rglob(pattern))[:25]
            return "\n".join(str(m) for m in matches) if matches else f"No files matching '{pattern}' found."

        elif name == "read_file":
            p = _safe_path(args.get("path", ""))
            if p is None:
                return "Error: file must be within your home directory."
            if not p.exists():
                return f"File not found: {p}"
            if p.stat().st_size > 50_000:
                return "File too large to read in full (>50 KB)."
            text = p.read_text(encoding="utf-8", errors="replace")
            return text[:4000] + ("\n...(truncated)" if len(text) > 4000 else "")

        elif name == "apt_search":
            query = args.get("query", "").strip()
            if not query:
                return "Error: query is required."
            r = subprocess.run(["apt-cache", "search", "--names-only", query],
                               capture_output=True, text=True, timeout=10)
            lines = [l for l in r.stdout.strip().split("\n") if l][:20]
            return "\n".join(lines) if lines else f"No packages found matching '{query}'."

        elif name == "list_installed":
            f = args.get("filter", "").strip()
            cmd = ["dpkg", "-l"] + ([f"*{f}*"] if f else [])
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
            installed = []
            for line in r.stdout.split("\n"):
                if line.startswith("ii"):
                    parts = line.split()
                    if len(parts) >= 3:
                        installed.append(f"{parts[1]}  {parts[2]}")
            return "\n".join(installed[:30]) if installed else "No matching packages found."

        elif name == "create_note":
            NOTES_DIR.mkdir(parents=True, exist_ok=True)
            raw = args.get("filename", "note").strip()
            safe = re.sub(r'[^\w\-. ]', '_', raw).strip() or "note"
            if not safe.endswith(".md"):
                safe += ".md"
            path = NOTES_DIR / safe
            path.write_text(args.get("content", ""), encoding="utf-8")
            return f"Note saved: {path}"

        elif name == "move_file":
            src = _safe_path(args.get("source", ""))
            dst_raw = args.get("destination", "")
            dst = Path(dst_raw).expanduser()
            if src is None:
                return "Error: source must be within your home directory."
            if _safe_path(str(dst.parent)) is None:
                return "Error: destination must be within your home directory."
            if not src.exists():
                return f"Source not found: {src}"
            dst_res = dst.resolve()
            if dst_res.exists():
                return f"Error: destination already exists: {dst_res}"
            dst_res.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(src), str(dst_res))
            return f"Moved: {src} → {dst_res}"

        return f"Unknown tool: {name}"

    except subprocess.TimeoutExpired:
        return f"Tool '{name}' timed out."
    except PermissionError as e:
        return f"Permission denied: {e}"
    except Exception as e:
        return f"Tool error ({name}): {e}"


# ── Global state ──────────────────────────────────────────────────────────────
stt: WhisperModel | None = None
client: OpenAI | None = None
current_voice: PiperVoice | None = None
current_voice_id: str = ""
vector_store: VectorStore | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global stt, client, current_voice, current_voice_id, vector_store

    print("[server] Loading Whisper STT…", flush=True)
    stt = WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8")

    print("[server] Initialising OpenAI client…", flush=True)
    client = OpenAI(base_url=LM_STUDIO_URL, api_key="lm-studio")

    print("[server] Loading default Piper voice…", flush=True)
    current_voice = PiperVoice.load(DEFAULT_VOICE)
    current_voice_id = DEFAULT_VOICE

    print("[server] Loading vector store…", flush=True)
    vector_store = VectorStore(RAG_DIR)
    print(f"[server] Vector store ready — {len(vector_store.docs)} doc(s).", flush=True)

    print("[server] Ready.", flush=True)
    yield


app = FastAPI(lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


# ── Text helpers ──────────────────────────────────────────────────────────────

def extract_text(content: bytes, filename: str) -> str:
    if filename.lower().endswith(".pdf"):
        if not PYMUPDF_OK:
            raise ValueError("PDF support requires pymupdf: pip install pymupdf")
        doc = fitz.open(stream=content, filetype="pdf")
        return "\n\n".join(p.get_text() for p in doc if p.get_text().strip())
    return content.decode("utf-8", errors="replace")


def chunk_text(text: str, chunk_size: int = 400, overlap: int = 60) -> list[str]:
    words = text.split()
    chunks, i = [], 0
    while i < len(words):
        chunk = " ".join(words[i : i + chunk_size])
        if len(chunk.strip()) > 80:
            chunks.append(chunk)
        i += chunk_size - overlap
    return chunks


def embed_texts(texts: list[str]) -> list[list[float]]:
    all_emb: list[list[float]] = []
    for i in range(0, len(texts), 8):
        resp = client.embeddings.create(model="local-model", input=texts[i : i + 8])
        all_emb.extend(e.embedding for e in resp.data)
    return all_emb


def clean_for_tts(text: str) -> str:
    text = re.sub(r'```.*?```', '', text, flags=re.DOTALL)
    text = re.sub(r'`[^`]*`', '', text)
    text = re.sub(r'^#{1,6}\s+', '', text, flags=re.MULTILINE)
    text = re.sub(r'\*{1,3}(.*?)\*{1,3}', r'\1', text, flags=re.DOTALL)
    text = re.sub(r'_{1,2}(.*?)_{1,2}', r'\1', text, flags=re.DOTALL)
    text = re.sub(r'~~(.*?)~~', r'\1', text)
    text = re.sub(r'\[([^\]]+)\]\([^\)]*\)', r'\1', text)
    text = re.sub(r'^\s*>\s?', '', text, flags=re.MULTILINE)
    text = re.sub(r'^\s*[-•*]\s+', '', text, flags=re.MULTILINE)
    text = re.sub(r'^\s*\d+[.)]\s+', '', text, flags=re.MULTILINE)
    text = re.sub(r'^[-*_]{3,}\s*$', '', text, flags=re.MULTILINE)
    text = re.sub(r'[*_]', '', text)
    text = text.replace('—', ', ').replace('–', ', ')
    text = re.sub(r'\n{2,}', ' ', text)
    return re.sub(r'\s+', ' ', text).strip()


def format_reply(text: str) -> str:
    """Add paragraph breaks at sentence boundaries for readable display."""
    if '\n\n' in text:
        return text  # already has structure, leave it alone
    return re.sub(r'([.!?])\s+(?=[A-Z"\'\(])', r'\1\n\n', text).strip()


def _synthesize_wav(text: str) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        first = True
        for chunk in current_voice.synthesize(text):
            if first:
                wf.setnchannels(chunk.sample_channels)
                wf.setsampwidth(chunk.sample_width)
                wf.setframerate(chunk.sample_rate)
                first = False
            wf.writeframes(chunk.audio_int16_bytes)
    return buf.getvalue()


# ── Core endpoints ────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    try:
        models = client.models.list()
        name = models.data[0].id if models.data else "unknown"
        return {"status": "ok", "model": name}
    except Exception as e:
        return {"status": "error", "error": str(e)}


@app.get("/voices")
async def voices():
    paths = sorted(glob.glob(os.path.join(VOICE_DIR, "*.onnx")))
    return {
        "voices": [{"id": p, "name": os.path.splitext(os.path.basename(p))[0],
                    "current": p == current_voice_id} for p in paths],
        "current": current_voice_id,
    }


@app.post("/voice")
async def set_voice(request: Request):
    global current_voice, current_voice_id
    body = await request.json()
    voice_id = body.get("voice_id", "")
    if not voice_id or not os.path.isfile(voice_id):
        return {"error": f"Voice not found: {voice_id}"}
    current_voice = PiperVoice.load(voice_id)
    current_voice_id = voice_id
    return {"ok": True, "voice_id": voice_id}


@app.post("/transcribe")
async def transcribe(request: Request, sample_rate: int = 44100):
    body = await request.body()
    audio = np.frombuffer(body, dtype=np.float32).copy()
    if len(audio) == 0:
        return {"transcript": ""}
    audio_16k = scipy.signal.resample(audio, int(len(audio) * 16000 / sample_rate))
    segments, _ = stt.transcribe(audio_16k, beam_size=5, language="en")
    return {"transcript": " ".join(s.text for s in segments).strip()}


@app.post("/chat")
async def chat(request: Request):
    body       = await request.json()
    transcript: str  = body.get("transcript", "")
    history:    list = body.get("history", [])

    # ── RAG retrieval ──────────────────────────────────────────────────────
    rag_context  = ""
    rag_results: list[dict] = []
    if not vector_store.is_empty:
        try:
            q_emb = embed_texts([transcript])[0]
            rag_results = vector_store.query(q_emb, k=RAG_K)
            if rag_results:
                sources    = list(dict.fromkeys(r["filename"] for r in rag_results))
                ctx_parts  = [f'[{r["filename"]}]\n{r["text"]}' for r in rag_results]
                rag_context = (f"\n\nRelevant context from: {', '.join(sources)}\n\n"
                               + "\n---\n".join(ctx_parts))
                print(f"[server] RAG: {len(rag_results)} chunk(s) from {sources}", flush=True)
        except Exception as e:
            print(f"[server] RAG error: {e}", flush=True)

    # ── Build initial messages ─────────────────────────────────────────────
    system   = SYSTEM_PROMPT + rag_context
    messages = [{"role": "system", "content": system}] + list(history)
    messages.append({"role": "user", "content": transcript})

    # ── Agentic loop ───────────────────────────────────────────────────────
    tools_used:  list[str] = []
    tool_events: list[dict] = []   # for UI display
    reply = ""

    for _iter in range(AGENT_MAX_ITER):
        try:
            resp = client.chat.completions.create(
                model="local-model",
                messages=messages,
                tools=TOOLS,
                tool_choice="auto",
            )
        except Exception as e:
            # If the model/server doesn't support tools, fall back to plain completion
            print(f"[server] tools API error ({e}), retrying without tools", flush=True)
            try:
                resp = client.chat.completions.create(model="local-model", messages=messages)
                reply = (resp.choices[0].message.content or "").strip()
            except Exception as e2:
                return {"error": str(e2)}
            break

        msg = resp.choices[0].message

        # No tool calls → final answer
        if not msg.tool_calls:
            reply = (msg.content or "").strip()
            break

        # Append assistant turn (with tool_calls) to message history
        messages.append({
            "role":       "assistant",
            "content":    msg.content or "",
            "tool_calls": [
                {"id": tc.id, "type": "function",
                 "function": {"name": tc.function.name, "arguments": tc.function.arguments}}
                for tc in msg.tool_calls
            ],
        })

        # Execute each tool call
        for tc in msg.tool_calls:
            name = tc.function.name
            try:
                args = json.loads(tc.function.arguments)
            except Exception:
                args = {}

            label = TOOL_LABELS.get(name, name)
            print(f"[server] ⚙ {name}({args})", flush=True)
            result = execute_tool(name, args)
            print(f"[server]   → {result[:120]}", flush=True)

            tools_used.append(name)
            tool_events.append({"tool": name, "label": label, "result": result[:300]})

            messages.append({"role": "tool", "tool_call_id": tc.id, "content": result})
    else:
        # Max iterations hit — request a plain summary
        try:
            resp = client.chat.completions.create(model="local-model", messages=messages)
            reply = (resp.choices[0].message.content or "").strip()
        except Exception as e:
            return {"error": str(e)}

    if not reply:
        reply = "Done."

    reply     = format_reply(reply)
    spoken    = clean_for_tts(reply)
    wav_bytes = _synthesize_wav(spoken)
    audio_b64 = base64.b64encode(wav_bytes).decode()
    rag_sources = list(dict.fromkeys(r["filename"] for r in rag_results)) if rag_context else []

    return {
        "reply":       reply,
        "audio_b64":   audio_b64,
        "rag_sources": rag_sources,
        "tools_used":  tools_used,
        "tool_events": tool_events,
    }


# ── RAG endpoints ─────────────────────────────────────────────────────────────

@app.post("/upload")
async def upload_document(file: UploadFile = File(...)):
    content  = await file.read()
    filename = file.filename or "untitled"
    try:
        text = extract_text(content, filename)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if not text.strip():
        raise HTTPException(status_code=400, detail="No text could be extracted.")
    chunks = chunk_text(text)
    if not chunks:
        raise HTTPException(status_code=400, detail="Document too short to process.")
    print(f"[server] Embedding {len(chunks)} chunks for '{filename}'…", flush=True)
    try:
        embeddings = embed_texts(chunks)
    except Exception as e:
        raise HTTPException(status_code=500,
            detail=f"Embedding failed: {e}. Load an embedding model in LM Studio.")
    doc_id = uuid.uuid4().hex[:8]
    vector_store.add(doc_id, filename, chunks, embeddings)
    print(f"[server] Stored '{filename}' as {doc_id} ({len(chunks)} chunks).", flush=True)
    return {"doc_id": doc_id, "filename": filename, "chunks": len(chunks)}


@app.get("/documents")
async def list_documents():
    return {"documents": vector_store.list_docs()}


@app.delete("/documents/{doc_id}")
async def delete_document(doc_id: str):
    if vector_store.remove(doc_id):
        return {"ok": True}
    raise HTTPException(status_code=404, detail="Document not found.")
