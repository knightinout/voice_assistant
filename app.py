#!/usr/bin/env python3
"""Local voice assistant — Gradio UI, fully on-device, errors shown in UI."""

import os, sys, tempfile
import numpy as np
import gradio as gr
import scipy.signal
from faster_whisper import WhisperModel
from openai import OpenAI

# ── Config ────────────────────────────────────────────────────────────────────
WHISPER_MODEL    = "base"
if sys.platform == "darwin":
    _data_dir = os.path.expanduser("~/Library/Application Support/piper")
elif sys.platform == "win32":
    _data_dir = os.path.join(os.environ.get("LOCALAPPDATA", os.path.expanduser("~/AppData/Local")), "piper")
else:
    _data_dir = os.path.expanduser("~/.local/share/piper")
PIPER_MODEL_PATH = os.path.join(_data_dir, "en_US-lessac-medium.onnx")
LM_STUDIO_URL    = "http://localhost:1234/v1"
SYSTEM_PROMPT    = ("You are a helpful assistant. "
                    "Give concise spoken responses — avoid markdown, bullet points, and code blocks.")
# ─────────────────────────────────────────────────────────────────────────────

print("Loading Whisper STT model…")
try:
    stt = WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8")
    STT_OK = True
    STT_ERR = ""
except Exception as e:
    STT_OK = False
    STT_ERR = str(e)

client = OpenAI(base_url=LM_STUDIO_URL, api_key="lm-studio")

_piper_voice = None
PIPER_ERR = None

def get_piper():
    global _piper_voice, PIPER_ERR
    if _piper_voice is None and PIPER_ERR is None:
        try:
            from piper.voice import PiperVoice
            _piper_voice = PiperVoice.load(PIPER_MODEL_PATH)
        except Exception as e:
            PIPER_ERR = str(e)
    return _piper_voice


def check_lmstudio() -> str:
    try:
        models = client.models.list()
        names = [m.id for m in models.data]
        if names:
            return f"✅ Connected — model: {names[0]}"
        return "⚠️ LM Studio running but no model loaded. Open LM Studio, load a model, and enable Local Server."
    except Exception as e:
        return f"❌ LM Studio not reachable ({e})\nOpen LM Studio → load a model → click Start Server."


def to_float32_mono_16k(audio) -> np.ndarray | None:
    if audio is None:
        return None
    sample_rate, raw = audio
    if raw.dtype != np.float32:
        raw = raw.astype(np.float32) / (np.iinfo(raw.dtype).max if np.issubdtype(raw.dtype, np.integer) else 1.0)
    if raw.ndim > 1:
        raw = raw.mean(axis=1)
    if sample_rate != 16000:
        raw = scipy.signal.resample(raw, int(len(raw) * 16000 / sample_rate))
    return raw


def trim_silence(audio: np.ndarray) -> np.ndarray:
    """Energy-based silence trim — no extra dependencies."""
    frame = 1600  # 100ms at 16kHz
    energy = [np.sqrt(np.mean(audio[i:i+frame]**2)) for i in range(0, len(audio) - frame, frame)]
    if not energy:
        return audio
    threshold = max(energy) * 0.05
    speech = [i for i, e in enumerate(energy) if e > threshold]
    if not speech:
        return audio
    start = max(0, speech[0] * frame - frame)
    end   = min(len(audio), (speech[-1] + 2) * frame)
    return audio[start:end]


def process_turn(audio, history):
    if not STT_OK:
        return history, None, f"❌ STT model failed to load: {STT_ERR}"
    if audio is None:
        return history, None, "No audio — click the microphone, speak, then click Stop, then Send."

    raw = to_float32_mono_16k(audio)
    if raw is None or len(raw) < 3200:
        return history, None, "Recording too short — please speak for at least 0.2 seconds."

    raw = trim_silence(raw)

    # STT
    try:
        segments, _ = stt.transcribe(raw, beam_size=5, language="en")
        transcript = " ".join(s.text for s in segments).strip()
    except Exception as e:
        return history, None, f"❌ Transcription error: {e}"

    if not transcript:
        return history, None, "No speech detected — speak clearly and try again."

    # Build messages with history (Gradio 6+ uses messages-format dicts)
    messages = [{"role": "system", "content": SYSTEM_PROMPT}]
    for msg in history:
        messages.append({"role": msg["role"], "content": msg["content"]})
    messages.append({"role": "user", "content": transcript})

    # LLM
    try:
        resp = client.chat.completions.create(model="local-model", messages=messages)
        reply = resp.choices[0].message.content
    except Exception as e:
        err = str(e)
        if "Connection refused" in err or "connect" in err.lower():
            return history, None, "❌ LM Studio not reachable. Open LM Studio, load a model, start the Local Server."
        return history, None, f"❌ LM Studio error: {err}"

    # TTS
    tts_path = None
    tts_note = ""
    voice = get_piper()
    if voice:
        try:
            import wave
            tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
            tmp.close()
            with wave.open(tmp.name, "wb") as wf:
                first = True
                for chunk in voice.synthesize(reply):
                    if first:
                        wf.setnchannels(chunk.sample_channels)
                        wf.setsampwidth(chunk.sample_width)
                        wf.setframerate(chunk.sample_rate)
                        first = False
                    wf.writeframes(chunk.audio_int16_bytes)
            tts_path = tmp.name
        except Exception as e:
            tts_note = f" (TTS error: {e})"
    else:
        tts_note = f" (TTS unavailable: {PIPER_ERR})"

    history.append({"role": "user", "content": transcript})
    history.append({"role": "assistant", "content": reply})
    return history, tts_path, f"You said: {transcript}{tts_note}"


# ── UI ────────────────────────────────────────────────────────────────────────
with gr.Blocks(title="Voice Assistant") as demo:
    gr.Markdown("## Local Voice Assistant")

    with gr.Row():
        connection_status = gr.Textbox(
            label="LM Studio Status",
            value=check_lmstudio(),
            interactive=False,
            max_lines=2,
            scale=5,
        )
        refresh_btn = gr.Button("Refresh", size="sm", scale=1)
    refresh_btn.click(check_lmstudio, outputs=connection_status)

    chatbot = gr.Chatbot(label="Conversation", height=460)

    # Dedicated row for response audio — keeps it full-width and clickable
    audio_out = gr.Audio(
        label="Response",
        autoplay=True,
        interactive=False,
    )

    status_bar = gr.Textbox(label="Status", interactive=False, max_lines=2)

    with gr.Row():
        audio_in = gr.Audio(
            sources=["microphone"],
            type="numpy",
            label="Tap mic → speak → tap Stop  (sends automatically)",
            interactive=True,
            scale=5,
        )
        clear_btn = gr.Button("Clear Chat", scale=1)

    # Auto-send the moment recording stops — no Send button needed
    audio_in.stop_recording(
        process_turn,
        inputs=[audio_in, chatbot],
        outputs=[chatbot, audio_out, status_bar],
    )

    clear_btn.click(
        lambda: ([], None, None, ""),
        outputs=[chatbot, audio_out, audio_in, status_bar],
    )

demo.launch(server_name="127.0.0.1", server_port=7860, share=False, show_error=True, quiet=True, theme=gr.themes.Soft())
