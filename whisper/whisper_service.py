import asyncio
import functools
import os
import tempfile
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from faster_whisper import WhisperModel

MODEL_NAME = os.getenv("WHISPER_MODEL", "medium.en")
DEVICE = os.getenv("WHISPER_DEVICE", "cpu")
COMPUTE_TYPE = os.getenv("WHISPER_COMPUTE_TYPE", "int8")

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
async def transcribe(
    audio: UploadFile = File(...),
    prompt: str = Form(default=""),
) -> dict[str, object]:
    suffix = Path(audio.filename or "audio.webm").suffix or ".webm"
    temp_path = ""

    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as temp_file:
            temp_path = temp_file.name
            while chunk := await audio.read(1024 * 1024):
                temp_file.write(chunk)

        transcribe_call = functools.partial(
            model.transcribe,
            language="en",
            beam_size=1,
            best_of=1,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 400},
            initial_prompt=prompt or None,
            condition_on_previous_text=False,
        )
        loop = asyncio.get_running_loop()
        segments, info = await loop.run_in_executor(None, transcribe_call, temp_path)
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
