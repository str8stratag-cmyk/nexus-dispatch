import asyncio
from concurrent.futures import ThreadPoolExecutor
import functools
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

from text_fixes import EXTRA_HOMOPHONE_FIXES, is_blocklisted_chunk, strip_trailing_signoff

# Fleet standard since 2026-09-28 (user decision): small.en on every box.
MODEL_NAME = os.getenv("WHISPER_MODEL", "small.en")
DEVICE = os.getenv("WHISPER_DEVICE", "cpu")
COMPUTE_TYPE = os.getenv("WHISPER_COMPUTE_TYPE", "int8")
API_KEY = os.getenv("WHISPER_API_KEY")

# Clean style-only initial prompt — NO keyword lists, street lists, or call
# examples. The old prompt ("Dispatch radio terminology: <keywords>. Local
# street names: Olla.") was echoed verbatim into transcripts on garble, and
# each echoed keyword fired the event pipeline (junk events + quarantine
# noise). A concrete call example in the prompt fabricated ~330 bogus events
# one weekend (2026-09-08, client fix c16ffa2). 2026-09-21: single clean
# prompt owned here; request-supplied prompts are deliberately IGNORED
# (old fleet senders still transmit keyword lists; honoring them would
# re-open the echo vector). If this prompt ever fabricates on silence,
# set it to None — that was the winning arm of the 2026-09-18 A/B.
# FLIPPED TO None 2026-09-21: CLEAN_PROMPT fabricated verbatim into a live
# DISP-2 event at 11:03 AM (prompt echo), so the service now transcribes
# with no initial_prompt at all.
CLEAN_PROMPT = None

# Opt-in: set WHISPER_SAVE_AUDIO to a directory to retain incoming chunks
# (audio + JSON sidecar with transcript and confidence) for tuning. Ring
# buffer — oldest files are deleted past WHISPER_SAVE_MAX files.
SAVE_AUDIO_DIR = os.getenv("WHISPER_SAVE_AUDIO") or None
SAVE_AUDIO_MAX = int(os.getenv("WHISPER_SAVE_MAX", "200"))


def _env_int(name: str, default: int, lo: int, hi: int) -> int:
    """Per-box integer knob from the environment (start-whisper.ps1 forwards
    whitelisted keys from the untracked whisper-model.local). Missing or
    invalid values fall back to the default, which equals the pre-2026-09-25
    behavior."""
    raw = os.getenv(name, "").strip()
    try:
        value = int(raw)
    except ValueError:
        return default
    return value if lo <= value <= hi else default


def _env_flag(name: str) -> bool:
    return os.getenv(name, "").strip().lower() in ("1", "true", "yes", "on")


# Per-box decode knobs (2026-09-25 call review). Defaults = previous
# hard-coded values, so a box without these keys behaves exactly as before.
# The 2-core medium.en boxes decode a 4s chunk in ~11s at beam 5; beam 2
# trades a little accuracy for throughput so fewer chunks are dropped by
# the client's 2-deep queue.
BEAM_SIZE = _env_int("WHISPER_BEAM_SIZE", 5, 1, 10)
BEST_OF = _env_int("WHISPER_BEST_OF", 5, 1, 10)
# Optional hotwords (faster-whisper prepends them to the decoder prompt).
# Default OFF: prompt text has echoed verbatim into transcripts before
# (2026-09-08, 2026-09-21). Enable per box only with debug-audio sidecars on
# so echo can be audited.
# WHISPER_HOTWORDS=recommended uses RECOMMENDED_HOTWORDS (street names Whisper
# keeps mangling); any other non-empty value is used verbatim.
RECOMMENDED_HOTWORDS = "Signal 4, MacDill, McDill, Adamo, Orient, Dale Mabry, Bruce B Downs"
_HOTWORDS_RAW = os.getenv("WHISPER_HOTWORDS", "").strip()
HOTWORDS = (RECOMMENDED_HOTWORDS if _HOTWORDS_RAW.lower() in ("recommended", "default")
            else _HOTWORDS_RAW) or None
# Opt-in text post-processing added 2026-09-25 (both default OFF).
EXTRA_FIXES_ENABLED = _env_flag("WHISPER_EXTRA_FIXES")
BLOCKLIST_ENABLED = _env_flag("WHISPER_BLOCKLIST")

# Known homophone corrections: word-boundary, case-insensitive; the
# replacement always uses the intended casing. Add entries here when call
# review surfaces a recurring mis-transcription (e.g. the street "Ola Ave"
# comes out as "alla").
HOMOPHONE_FIXES: list[tuple[re.Pattern[str], str]] = [
    # "8401 North Carolina Street" (2026-10-01, real quarantine misses on
    # four independent boxes) - real address is "3401 S Carolina St"
    # (user-confirmed 2026-10-02). Optional leading "4" catches "Signal 4"
    # fusing into "8401" with no space ("48401 North Carolina Street").
    (re.compile(r"\b4?8401\s+north\s+carolina(?:\s+st(?:reet)?)?\b", re.IGNORECASE), "3401 S Carolina St"),
    (re.compile(r"\balla\b", re.IGNORECASE), "Ola"),
    # "amd" is Whisper's mis-hearing of "and" between street names; the junk
    # token breaks intersection parsing ("AZEELE AMD TAMPANIA").
    (re.compile(r"\bamd\b", re.IGNORECASE), "and"),
    # Plate reads: "Florida tag" comes out as "Florida Tech" / "Flirtag".
    (re.compile(r"\bflorida tech\b", re.IGNORECASE), "Florida tag"),
    (re.compile(r"\bflirtag\b", re.IGNORECASE), "Florida tag"),
    # "bush" is nearly always Busch Blvd in Tampa road context; literal
    # shrubbery mentions are rare and harmless if renamed. "bushed" (2026-09-30
    # call review, "each bound bushed" for "eastbound Busch"): \bbush\b alone
    # doesn't match it — "bush" and "ed" are one contiguous word.
    (re.compile(r"\bbush(?:ed)?\b", re.IGNORECASE), "Busch"),
    # "eastbound" heard as two words, "bound" swallowing the "t".
    (re.compile(r"\beach\s+bound\b", re.IGNORECASE), "eastbound"),
    # Selmon/Crosstown Expressway (2026-09-30, real DISP-5 quarantine miss:
    # "settlement expressway" for "Selmon Expressway"; also "salmon"/
    # "sandman"/"sellman"). When "expressway"/"expy" is actually said, keep
    # it in the fixed text. Real dispatchers say it bare ~98% of the time
    # (user, 2026-09-30) — the bare fallback below (must run AFTER this one:
    # once "expressway"/"expy" is consumed here, it can't double-match) is
    # what catches the common case.
    (re.compile(r"\b(?:settlement|salmon|sandman|sellman)\s+(?:expressway|expy)\b", re.IGNORECASE), "Selmon Expressway"),
    (re.compile(r"\b(?:settlement|salmon|sandman|sellman)\b", re.IGNORECASE), "Selmon"),
    # "Dale Labrie" for "Dale Mabry" (2026-09-30, real DISP-2 quarantine
    # miss). No Anderson -> Henderson rewrite: both are real Tampa roads
    # (owner decision 2026-10-01).
    (re.compile(r"\bdale\s+labrie\b", re.IGNORECASE), "Dale Mabry"),
    # "304 East Handler" (2026-10-01, real quarantine misses across
    # DISP-1/2/5/7, user-confirmed canonical name). "Tambler" is the
    # mishearing; "Handler" itself is already correct when heard right.
    (re.compile(r"\btambler\b", re.IGNORECASE), "Handler"),
    # Armenia Ave & Broad St (2026-10-01, real DISP-2/3 quarantine misses,
    # user-confirmed). "Barat" for "Broad" only in a street context
    # ("Barat Street", "West Barat") - it is also a surname. "Armenian" (the
    # nationality adjective, a real word that could describe a person)
    # requires "Avenue"/"Ave" - matches how it appeared in both real
    # transcripts.
    (re.compile(r"\bbarat(?=\s+(?:st|street)\b)", re.IGNORECASE), "Broad"),
    (re.compile(r"\b(north|south|east|west)\s+barat\b", re.IGNORECASE), r"\1 Broad"),
    (re.compile(r"\barmenian\s+(?:avenue|ave)\b", re.IGNORECASE), "Armenia Avenue"),
    # Street-name garbles (2026-09-18 call review, 500 events).
    (re.compile(r"\bmckin\w*\b", re.IGNORECASE), "McKinley"),
    (re.compile(r"\bmcdill+\b", re.IGNORECASE), "MacDill"),
    (re.compile(r"\bunkown\b", re.IGNORECASE), "unknown"),
    (re.compile(r"\bcyprus\b", re.IGNORECASE), "Cypress"),
    (re.compile(r"\bcypruss\b", re.IGNORECASE), "Cypress"),
    (re.compile(r"\bcyprees\b", re.IGNORECASE), "Cypress"),
    (re.compile(r"\bosbourne\b", re.IGNORECASE), "Osborne"),
    (re.compile(r"\barbenia\b", re.IGNORECASE), "Armenia"),
    (re.compile(r"\bashely\b", re.IGNORECASE), "Ashley"),
    (re.compile(r"\binterstte\b", re.IGNORECASE), "Interstate"),
    (re.compile(r"\bsignaal\b", re.IGNORECASE), "Signal"),
    # Local box call-review additions (2026-09-21): "Hale Ave" comes out as
    # "hell ave/avenue"; "Morris Bridge" collapses to "slambridge".
    (re.compile(r"\bhell\s+(?:ave|avenue)\b", re.IGNORECASE), "Hale Ave"),
    (re.compile(r"\bslambridge\b", re.IGNORECASE), "Morris Bridge"),
]


def apply_homophone_fixes(text: str) -> str:
    for pattern, replacement in HOMOPHONE_FIXES:
        text = pattern.sub(replacement, text)
    if EXTRA_FIXES_ENABLED:
        for pattern, replacement in EXTRA_HOMOPHONE_FIXES:
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
# resets ("Failed to fetch"). One at a time keeps per-chunk latency flat.
# This box keeps the async endpoint (sync-def uploads stalled at ~2KB/s
# through the venv launcher chain here — see the note at /transcribe), so the
# one-at-a-time guarantee comes from this dedicated single-worker executor:
# same serialization as the upstream threading.Lock, without blocking the
# event loop. Bump max_workers only on bigger boxes.
# The client capture hook serializes too — this is the backstop for any
# direct POSTer (fleet boxes POSTing here instead of their local Whisper).
_transcribe_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="transcribe")


def _transcribe_all(path: str):
    """Transcribe AND consume the lazy segment generator in the worker thread.

    faster-whisper returns `segments` as a generator whose inference runs at
    first iteration, not at the transcribe() call. Materializing it here keeps
    all CPU-bound inference inside the single-worker executor, so the caller's
    per-chunk timeout actually covers inference and the event loop (which
    serves /health) stays responsive.
    """
    segments, info = model.transcribe(
        path,
        language="en",
        beam_size=BEAM_SIZE,
        best_of=BEST_OF,
        hotwords=HOTWORDS,
        temperature=(0.0, 0.2, 0.4),
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 700},
        # 2026-09-21: single clean style-only prompt for all
        # requests (see CLEAN_PROMPT above); request-supplied
        # prompts are ignored on purpose.
        initial_prompt=CLEAN_PROMPT,
        condition_on_previous_text=False,
        compression_ratio_threshold=2.4,
    )
    return list(segments), info

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
        # Only a request that is actually WAITING (started after the last
        # completion) can be starved by a wedge. Without this guard a quiet
        # radio (no chunk for 5+ minutes) plus a slow /health under desktop
        # load would kill a healthy idle service.
        request_waiting = _LIVENESS["last_request"] > _LIVENESS["last_done"]
        if fails >= 10 and request_waiting and now - _LIVENESS["last_done"] > 300:
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
        # Effective per-box tuning (2026-09-25) so rollouts can be verified
        # from /health without reading files on the box.
        "beam_size": str(BEAM_SIZE),
        "best_of": str(BEST_OF),
        "hotwords": "on" if HOTWORDS else "off",
        "nsp_threshold": os.getenv("WHISPER_NSP_THRESHOLD", "0.5"),
        "cr_threshold": os.getenv("WHISPER_CR_THRESHOLD", "2.0"),
        "extra_fixes": "on" if EXTRA_FIXES_ENABLED else "off",
        "blocklist": "on" if BLOCKLIST_ENABLED else "off",
    }


@app.post("/transcribe")
# 2026-09-17 (DISP-2): async + executor transport restored; the sync-def
# variant slowed large uploads to ~2KB/s through the venv launcher chain.
# /health may time out mid-transcription again (known quirk; no watchdog
# on this box).
async def transcribe(
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
            while chunk := await audio.read(1024 * 1024):
                temp_file.write(chunk)

        try:
            loop = asyncio.get_running_loop()
            _t0 = time.time()
            # Hard per-chunk deadline: a hung inference (seen on 2026-09-21 —
            # one stuck 4s chunk blocked the single-worker executor, /health
            # wedged, and every following request failed until a manual
            # restart) must not asphyxiate the service. On timeout the
            # executor thread is unrecoverable, so exit and let the watchdog
            # relaunch a clean process. 300s is ~3x the worst legitimate
            # chunk on this box (107s measured under full CPU load on a 4s
            # clip, 2026-09-21); the in-service self-supervisor remains the
            # backstop for slower wedges.
            # IMPORTANT: _transcribe_all() consumes the lazy segment generator
            # INSIDE the worker thread — the original partial() returned a
            # generator whose inference ran below in the event-loop thread,
            # which both blocked /health and escaped this timeout.
            _WHISPER_TIMEOUT = float(os.getenv("WHISPER_TRANSCRIBE_TIMEOUT", "300"))
            try:
                segments, info = await asyncio.wait_for(
                    asyncio.wrap_future(_transcribe_executor.submit(_transcribe_all, temp_path)),
                    timeout=_WHISPER_TIMEOUT,
                )
            except asyncio.TimeoutError:
                print(
                    f"[supervisor] transcribe exceeded {_WHISPER_TIMEOUT}s — "
                    "executor wedged, exiting so the watchdog can relaunch",
                    flush=True,
                )
                os._exit(1)
            print(f"[timing] transcribe={time.time()-_t0:.1f}s audio={info.duration:.1f}s", flush=True)
            # _transcribe_all already materialized the segments (inference
            # completed inside the worker thread, under the timeout above).
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
        joined = " ".join(segment["text"] for segment in result_segments)
        if BLOCKLIST_ENABLED and joined and is_blocklisted_chunk(joined):
            for segment in result_segments:
                segment["dropped_reason"] = "blocklist"
            dropped_segments.extend(result_segments)
            result_segments = []
            joined = ""
            print("[blocklist] dropped whole-chunk hallucination", flush=True)
        elif BLOCKLIST_ENABLED and joined:
            # Strip a trailing YouTube-style sign-off ("..., thanks for
            # watching!") and trim the segments to match the kept text.
            stripped = strip_trailing_signoff(joined)
            if stripped != joined:
                keep_len = len(stripped)
                kept_segments = []
                offset = 0
                for segment in result_segments:
                    seg_text = segment["text"]
                    if offset >= keep_len:
                        segment["dropped_reason"] = "signoff"
                        dropped_segments.append(segment)
                    elif offset + len(seg_text) > keep_len:
                        segment["text"] = seg_text[: keep_len - offset].rstrip()
                        kept_segments.append(segment)
                    else:
                        kept_segments.append(segment)
                    offset += len(seg_text) + 1
                result_segments = [s for s in kept_segments if s["text"]]
                joined = " ".join(segment["text"] for segment in result_segments)
                print("[blocklist] stripped trailing sign-off", flush=True)
        result = {
            "text": joined,
            "language": info.language,
            "duration": info.duration,
            "model": MODEL_NAME,
            "segments": result_segments,
            "dropped_segments": dropped_segments,
        }
        if result["text"]:
            # One low-noise line per non-empty chunk: length plus a short
            # preview, so call review can correlate transcripts with events.
            _preview = result["text"][:80].replace("\n", " ")
            print(f"[text] len={len(result['text'])} preview={_preview!r}", flush=True)

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
