#!/usr/bin/env python3
"""
Voice assistant — no browser, direct mic access.
Press ENTER to start recording, ENTER again to stop and send.
Ctrl+C to quit.
"""

import os, sys, threading
import numpy as np
import sounddevice as sd
import scipy.signal
from faster_whisper import WhisperModel
from openai import OpenAI
try:
    from piper.voice import PiperVoice
    PIPER_OK = True
except ImportError:
    PiperVoice = None
    PIPER_OK = False

# ── Config ────────────────────────────────────────────────────────────────────
SAMPLE_RATE      = 16000
WHISPER_MODEL    = "small"
if sys.platform == "darwin":
    _data_dir = os.path.expanduser("~/Library/Application Support/piper")
elif sys.platform == "win32":
    _data_dir = os.path.join(os.environ.get("LOCALAPPDATA", os.path.expanduser("~/AppData/Local")), "piper")
else:
    _data_dir = os.path.expanduser("~/.local/share/piper")
PIPER_MODEL_PATH = os.path.join(_data_dir, "en_GB-jenny_dioco-medium.onnx")
LM_STUDIO_URL    = "http://localhost:1234/v1"
SYSTEM_PROMPT    = ("You are a helpful assistant. "
                    "Give concise spoken responses — avoid markdown, bullet points, and code blocks.")
# ─────────────────────────────────────────────────────────────────────────────

def banner(msg):
    print(f"\033[1;36m{msg}\033[0m")

def check_lmstudio(client):
    try:
        models = client.models.list()
        name = models.data[0].id if models.data else "unknown"
        banner(f"LM Studio connected — model: {name}")
    except Exception as e:
        print(f"\033[1;31mLM Studio not reachable: {e}\033[0m")
        print("Open LM Studio → load a model → Start Server, then run this again.")
        sys.exit(1)

def record_until_enter():
    """Stream mic until user presses Enter. Returns float32 mono 16kHz array."""
    frames = []
    stop_flag = threading.Event()

    def _callback(indata, frame_count, time_info, status):
        if not stop_flag.is_set():
            frames.append(indata.copy())

    stream = sd.InputStream(
        samplerate=SAMPLE_RATE,
        channels=1,
        dtype="float32",
        callback=_callback,
        blocksize=1024,
    )
    stream.start()
    input()          # blocks until Enter
    stop_flag.set()
    stream.stop()
    stream.close()

    if not frames:
        return np.zeros(0, dtype=np.float32)
    return np.concatenate(frames, axis=0).squeeze()

def trim_silence(audio):
    frame = 1600
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

def speak(voice, text):
    chunks = []
    src_sr = None
    for chunk in voice.synthesize(text):
        chunks.append(chunk.audio_float_array)
        src_sr = chunk.sample_rate
    if not chunks or src_sr is None:
        return
    audio = np.concatenate(chunks)
    device_sr = int(sd.query_devices(sd.default.device[1])['default_samplerate'])
    if src_sr != device_sr:
        audio = scipy.signal.resample_poly(audio, device_sr, src_sr)
    sd.play(audio, device_sr)
    sd.wait()

def main():
    banner("Loading Whisper STT…")
    stt = WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8")

    voice = None
    if PIPER_OK and os.path.isfile(PIPER_MODEL_PATH):
        banner("Loading Piper TTS…")
        voice = PiperVoice.load(PIPER_MODEL_PATH)
    else:
        reason = "piper not installed" if not PIPER_OK else f"voice not found: {PIPER_MODEL_PATH}"
        banner(f"TTS disabled ({reason}) — text-only mode")

    client = OpenAI(base_url=LM_STUDIO_URL, api_key="lm-studio")
    check_lmstudio(client)

    history = [{"role": "system", "content": SYSTEM_PROMPT}]

    print("\n\033[1mReady. Press ENTER to start recording, ENTER again to stop.\033[0m")
    print("Ctrl+C to quit.\n")

    while True:
        try:
            input("[ Press ENTER to record ]")
            print("\033[1;31m● Recording…  (press ENTER to stop)\033[0m", flush=True)

            audio = record_until_enter()

            if len(audio) < 3200:
                print("Too short — try again.\n")
                continue

            audio = trim_silence(audio)

            print("Transcribing…", flush=True)
            segments, _ = stt.transcribe(audio, beam_size=5, language="en")
            transcript = " ".join(s.text for s in segments).strip()

            if not transcript:
                print("No speech detected — try again.\n")
                continue

            print(f"\033[1mYou:\033[0m {transcript}")

            history.append({"role": "user", "content": transcript})

            print("Thinking…", flush=True)
            try:
                resp = client.chat.completions.create(model="local-model", messages=history)
                reply = resp.choices[0].message.content.strip()
            except Exception as e:
                print(f"LLM error: {e}\n")
                history.pop()
                continue

            history.append({"role": "assistant", "content": reply})
            print(f"\033[1mAssistant:\033[0m {reply}")

            if voice:
                print("Speaking…", flush=True)
                speak(voice, reply)
            print()

        except KeyboardInterrupt:
            print("\n\nGoodbye!")
            break

if __name__ == "__main__":
    main()
