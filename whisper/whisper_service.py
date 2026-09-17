import asyncio
import functools
import json
import os
import re
import tempfile
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

    try:
        if API_KEY and (not whisper_key or not compare_digest(whisper_key, API_KEY)):
            raise HTTPException(status_code=401, detail="Invalid Whisper API key")

        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as temp_file:
            temp_path = temp_file.name
            while chunk := audio.file.read(1024 * 1024):
                temp_file.write(chunk)

        transcribe_call = functools.partial(
            model.transcribe,
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
        loop = asyncio.get_running_loop()
        segments, info = await loop.run_in_executor(None, transcribe_call, temp_path)
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
