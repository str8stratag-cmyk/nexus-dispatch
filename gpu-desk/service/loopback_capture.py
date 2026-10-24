"""Optional standalone WASAPI loopback (system audio) capture.

Records what the desk is PLAYING (default speaker loopback, or --device),
cuts fixed 6 s chunks, POSTs each to the local Whisper server exactly like the
Chrome capture hook (multipart field 'audio', field 'prompt', optional
X-Whisper-Key), and appends results to logs\\transcripts-<SOURCE>.jsonl.

It does NOT POST to /api/dispatch: event extraction/keyword/quarantine logic
lives in the dispatch-monitor app. Use this for monitoring/backup/tuning, or
when the Chrome capture tab is not the audio path.
"""
import argparse
import io
import json
import os
import queue
import sys
import threading
import time
import wave
from datetime import datetime, timezone

import numpy as np
import requests

RATE = 16000


def to_wav(mono: np.ndarray) -> bytes:
    pcm = (np.clip(mono, -1.0, 1.0) * 32767).astype(np.int16)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", required=True, help="fleet source name, e.g. WHISP-1 (Zach to confirm)")
    ap.add_argument("--url", default=os.getenv("WHISPER_SERVICE_URL", "http://127.0.0.1:8178"))
    ap.add_argument("--chunk-sec", type=float, default=6.0)
    ap.add_argument("--silence-rms", type=float, default=0.003, help="skip chunks below this RMS (client does the same)")
    ap.add_argument("--device", default="", help="substring of speaker/mic name; default = default speaker loopback")
    ap.add_argument("--mic", action="store_true", help="capture a microphone instead of loopback")
    ap.add_argument("--out", required=True, help="JSONL output path")
    ap.add_argument("--list", action="store_true")
    args = ap.parse_args()

    import soundcard as sc

    if args.list:
        for m in sc.all_microphones(include_loopback=True):
            print(("LOOPBACK " if m.isloopback else "MIC      ") + m.name)
        return 0

    if args.mic:
        mic = sc.get_microphone(args.device) if args.device else sc.default_microphone()
    else:
        spk = sc.get_speaker(args.device) if args.device else sc.default_speaker()
        mic = sc.get_microphone(spk.name, include_loopback=True)
    print(f"[capture] source={args.source} device={mic.name!r} chunk={args.chunk_sec}s -> {args.url}", flush=True)

    headers = {}
    if os.getenv("WHISPER_API_KEY"):
        headers["X-Whisper-Key"] = os.environ["WHISPER_API_KEY"]
    q: "queue.Queue[tuple[float, float, np.ndarray]]" = queue.Queue(maxsize=2)  # client keeps a 2-deep queue too
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    heartbeat = os.path.abspath(args.out) + ".heartbeat"

    def sender() -> None:
        while True:
            t0, t1, mono = q.get()
            rec = {"ts": datetime.now(timezone.utc).isoformat(), "source": args.source,
                   "audioStartedAt": int(t0 * 1000), "audioEndedAt": int(t1 * 1000)}
            try:
                r = requests.post(f"{args.url}/transcribe", headers=headers, timeout=60,
                                  files={"audio": ("dispatch.wav", to_wav(mono), "audio/wav")},
                                  data={"prompt": "Dispatch radio terminology."})
                r.raise_for_status()
                j = r.json()
                rec.update(text=(j.get("text") or "").strip(), model=j.get("model"), duration=j.get("duration"))
            except Exception as e:  # keep capturing; watchdog watches the server
                rec.update(text="", error=str(e)[:300])
            if rec.get("text") or rec.get("error"):
                with open(args.out, "a", encoding="utf-8") as f:
                    f.write(json.dumps(rec, ensure_ascii=False) + "\n")

    threading.Thread(target=sender, daemon=True).start()
    frames = int(RATE * args.chunk_sec)
    with mic.recorder(samplerate=RATE, channels=1, blocksize=1024) as rec:
        while True:
            t0 = time.time()
            data = rec.record(numframes=frames)
            t1 = time.time()
            with open(heartbeat, "w") as hb:
                hb.write(str(int(t1)))
            mono = data.mean(axis=1) if data.ndim > 1 else data
            if float(np.sqrt(np.mean(mono ** 2))) < args.silence_rms:
                continue
            try:
                q.put_nowait((t0, t1, mono))
            except queue.Full:
                print("[capture] queue full, dropping chunk (Whisper behind)", flush=True)


if __name__ == "__main__":
    sys.exit(main())
