import json
import os
import re
import tempfile
import threading
import time
from hmac import compare_digest
from pathlib import Path

from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from faster_whisper import WhisperModel

MODEL_NAME = os.getenv("WHISPER_MODEL", "medium.en")
DEVICE = os.getenv("WHISPER_DEVICE", "cpu")
COMPUTE_TYPE = os.getenv("WHISPER_COMPUTE_TYPE", "int8")
API_KEY = os.getenv("WHISPER_API_KEY")
# Opt-in: set WHISPER_SAVE_AUDIO to a directory to retain incoming chunks
# (audio + JSON sidecar with transcript and confidence) for tuning. Ring
# buffer — oldest files are deleted past WHISPER_SAVE_MAX files.
SAVE_AUDIO_DIR = os.getenv("WHISPER_SAVE_AUDIO") or None
SAVE_AUDIO_MAX = int(os.getenv("WHISPER_SAVE_MAX", "200"))

# Known homophone corrections: word-boundary, case-insensitive; the
# replacement always uses the intended casing. Add entries here when call
# review surfaces a recurring mis-transcription (e.g. the street "Olla"
# by Men's World comes out as "alla").
HOMOPHONE_FIXES: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"\balla\b", re.IGNORECASE), "Olla"),
    # Plate reads: "Florida tag" comes out as "Florida Tech" / "Flirtag".
    (re.compile(r"\bflorida tech\b", re.IGNORECASE), "Florida tag"),
    (re.compile(r"\bflirtag\b", re.IGNORECASE), "Florida tag"),
    # "bush" is nearly always Busch Blvd in Tampa road context; literal
    # shrubbery mentions are rare and harmless if renamed.
    (re.compile(r"\bbush\b", re.IGNORECASE), "Busch"),
    # Street-name garbles (2026-09-18 call review, 500 events).
    (re.compile(r"\bmckin\w*\b", re.IGNORECASE), "McKinley"),
    (re.compile(r"\bmcdill+\b", re.IGNORECASE), "MacDill"),
    (re.compile(r"\bunkown\b", re.IGNORECASE), "unknown"),
    (re.compile(r"\bcyprus\b", re.IGNORECASE), "Cypress"),
    (re.compile(r"\bcypruss\b", re.IGNORECASE), "Cypress"),
    (re.compile(r"\bosbourne\b", re.IGNORECASE), "Osborne"),
    (re.compile(r"\barbenia\b", re.IGNORECASE), "Armenia"),
    (re.compile(r"\bashely\b", re.IGNORECASE), "Ashley"),
    (re.compile(r"\binterstte\b", re.IGNORECASE), "Interstate"),
    (re.compile(r"\bsignaal\b", re.IGNORECASE), "Signal"),
]


def apply_homophone_fixes(text: str) -> str:
    for pattern, replacement in HOMOPHONE_FIXES:
        text = pattern.sub(replacement, text)
    return text


def trim_repetition_loops(text: str) -> str:
    # Whisper stutter-loops on squelch/static at the tail of a transmission
    # ("...copy four, nba, nba, nba, nba"). Any word repeated 4+ times in a
    # row is loop junk — natural radio speech doubles/triples ("thank you,
    # thank you") are left alone.
    words = text.split()
    normalized = [re.sub(r"\W+", "", word).lower() for word in words]
    trimmed: list[str] = []
    i = 0
    while i < len(words):
        run = 1
        while i + run < len(words) and normalized[i + run] == normalized[i]:
            run += 1
        if run >= 4:
            i += run
            continue
        trimmed.extend(words[i : i + run])
        i += run
    return " ".join(trimmed)

app = FastAPI(title="Dispatch Monitor Whisper")
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("WHISPER_ALLOWED_ORIGINS", "*").split(","),
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)
model = WhisperModel(MODEL_NAME, device=DEVICE, compute_type=COMPUTE_TYPE)

# Serialize the CPU-bound transcription work. Parallel runs only contend for
# the same cores (a 2s clip measured 100s under a 40-deep pileup on DISP-4)
# and queued requests exhaust the threadpool until clients see connection
# resets ("Failed to fetch"). One at a time keeps per-chunk latency flat;
# /health stays responsive because this endpoint is a sync def (note above).
# The client capture hook serializes too — this is the backstop for any
# direct POSTer (fleet boxes POSTing here instead of their local Whisper).
TRANSCRIBE_LOCK = threading.Lock()

# Self-supervision (2026-09-18, after DISP-1's Whisper hung for 16h — TCP
# port LISTENING but /health never replying, zero events produced). A live
# watchdog catches that, but a box may run a dead or pre-fix watchdog, so the
# service verifies its own liveness and self-terminates to free the port.
# Wedged means: /health unresponsive for 5 straight minutes WHILE transcribes
# are being requested but none complete. Busy-but-healthy is never killed —
# completing transcribes is the liveness signal, so a CPU-saturated service
# under a room-audio flood (see AGENTS.md pileup note) is left alone.
_LIVENESS: dict[str, float] = {"last_request": 0.0, "last_done": 0.0}


def _self_supervise() -> None:
    import urllib.request

    fails = 0
    while True:
        time.sleep(30)
        now = time.time()
        if now - _LIVENESS["last_request"] > 600:
            # No client activity — nothing to protect; a wedged idle service
            # is the watchdog's job (it polls /health every minute).
            fails = 0
            continue
        try:
            with urllib.request.urlopen("http://127.0.0.1:8178/health", timeout=5) as res:
                healthy = res.status == 200
        except Exception:
            healthy = False
        if healthy:
            fails = 0
            continue
        fails += 1
        if fails >= 10 and now - _LIVENESS["last_done"] > 300:
            print(
                f"[supervisor] /health unresponsive {fails * 30}s with no "
                "transcribe completing — service wedged, exiting so a "
                "supervisor can relaunch it",
                flush=True,
            )
            os._exit(1)


threading.Thread(target=_self_supervise, daemon=True).start()


@app.get("/health")
def health() -> dict[str, str]:
    return {
        "ok": "true",
        "model": MODEL_NAME,
        "device": DEVICE,
        "compute_type": COMPUTE_TYPE,
    }


@app.post("/transcribe")
# Sync def on purpose: FastAPI runs it in a threadpool, so the CPU-heavy
# transcription cannot block the event loop and starve /health (which made
# the watchdog think Whisper was dead under load). Do not re-add "async"
# without reading the 2026-09-16 note in AGENTS.md.
def transcribe(
    audio: UploadFile = File(...),
    prompt: str = Form(default=""),
    whisper_key: str | None = Header(default=None, alias="X-Whisper-Key"),
) -> dict[str, object]:
    suffix = Path(audio.filename or "audio.webm").suffix or ".webm"
    temp_path = ""
    _LIVENESS["last_request"] = time.time()

    try:
        if API_KEY and (not whisper_key or not compare_digest(whisper_key, API_KEY)):
            raise HTTPException(status_code=401, detail="Invalid Whisper API key")

        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as temp_file:
            temp_path = temp_file.name
            while chunk := audio.file.read(1024 * 1024):
                temp_file.write(chunk)

        try:
            with TRANSCRIBE_LOCK:
                segments, info = model.transcribe(
                    temp_path,
                    language="en",
                    beam_size=5,
                    best_of=5,
                    temperature=(0.0, 0.2, 0.4),
                    vad_filter=True,
                    vad_parameters={"min_silence_duration_ms": 700},
                    initial_prompt=prompt or None,
                    condition_on_previous_text=False,
                    compression_ratio_threshold=2.4,
                )
                # NOTE: `segments` is a lazy generator — the inference runs
                # HERE, inside the loop below, not at the transcribe() call.
                nsp_drop = float(os.getenv("WHISPER_NSP_THRESHOLD", "0.5"))
                cr_drop = float(os.getenv("WHISPER_CR_THRESHOLD", "2.0"))
                result_segments: list[dict[str, object]] = []
                dropped_segments: list[dict[str, object]] = []
                for segment in segments:
                    if not segment.text.strip():
                        continue
                    text = trim_repetition_loops(apply_homophone_fixes(segment.text.strip()))
                    if not text:
                        # Segment was entirely a repetition loop.
                        continue
                    entry = {
                        "start": segment.start,
                        "end": segment.end,
                        "text": text,
                        "no_speech_prob": round(segment.no_speech_prob, 4),
                        "avg_logprob": round(segment.avg_logprob, 4),
                        "compression_ratio": round(segment.compression_ratio, 4),
                    }
                    # Hallucinated junk ("thanks for watching!", "one, two, three,
                    # four.") clusters at high no_speech_prob; compression_ratio
                    # catches counting loops. Calibrated on debug-audio sidecars:
                    # keepers (real road mentions) sit at nsp <= 0.17.
                    if segment.no_speech_prob > nsp_drop or segment.compression_ratio > cr_drop:
                        dropped_segments.append(entry)
                    else:
                        result_segments.append(entry)
        finally:
            # Inference returned (success or handled error) — the service is
            # making progress; the supervisor must not count this as a wedge.
            _LIVENESS["last_done"] = time.time()
        result = {
            "text": " ".join(segment["text"] for segment in result_segments),
            "language": info.language,
            "duration": info.duration,
            "model": MODEL_NAME,
            "segments": result_segments,
            "dropped_segments": dropped_segments,
        }

        if SAVE_AUDIO_DIR:
            save_dir = Path(SAVE_AUDIO_DIR)
            save_dir.mkdir(parents=True, exist_ok=True)
            stem = f"{int(time.time() * 1000)}"
            saved_audio = save_dir / f"{stem}{suffix}"
            Path(temp_path).replace(saved_audio)
            temp_path = ""
            (save_dir / f"{stem}.json").write_text(
                json.dumps({"prompt": prompt, **result}, indent=2),
                encoding="utf-8",
            )
            kept = sorted(save_dir.iterdir(), key=lambda p: p.stat().st_mtime)
            while len(kept) > SAVE_AUDIO_MAX:
                kept.pop(0).unlink(missing_ok=True)

        return result
    except Exception as error:
        raise HTTPException(status_code=500, detail=f"Whisper transcription failed: {error}") from error
    finally:
        if temp_path:
            Path(temp_path).unlink(missing_ok=True)
