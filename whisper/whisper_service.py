import os
import tempfile
from hmac import compare_digest
from pathlib import Path

from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from faster_whisper import WhisperModel

MODEL_NAME = os.getenv("WHISPER_MODEL", "medium.en")
DEVICE = os.getenv("WHISPER_DEVICE", "cpu")
COMPUTE_TYPE = os.getenv("WHISPER_COMPUTE_TYPE", "int8")
API_KEY = os.getenv("WHISPER_API_KEY")

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
# the watchdog think Whisper was dead under load). Do not re-add "async".
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

        segments, info = model.transcribe(
            temp_path,
            language="en",
            beam_size=5,
            best_of=5,
            temperature=(0.0, 0.2, 0.4),
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 700},
            initial_prompt=prompt or None,
            condition_on_previous_text=True,
            compression_ratio_threshold=2.4,
        )
        result_segments = [
            {"start": segment.start, "end": segment.end, "text": segment.text.strip()}
            for segment in segments
            if segment.text.strip()
        ]
        return {
            "text": " ".join(segment["text"] for segment in result_segments),
            "language": info.language,
            "duration": info.duration,
            "segments": result_segments,
        }
    except Exception as error:
        raise HTTPException(status_code=500, detail=f"Whisper transcription failed: {error}") from error
    finally:
        if temp_path:
            Path(temp_path).unlink(missing_ok=True)
