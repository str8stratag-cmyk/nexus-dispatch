# Dispatch Monitor — Project Context

## Project overview
A full-stack dispatch monitoring dashboard. It captures live audio, transcribes speech, detects emergency keywords, and creates dispatch events stored in MongoDB Atlas.

- Repo: `str8stratag-cmyk/dispatch-monitor`
- Local path: `C:\Users\str8s\dispatch-monitor` (DISP-4 master; fleet machines clone the same repo)
- Branch: `main`
- Deployment: **Vercel retired** (switched to MongoDB Atlas + locally-run apps on the fleet, at agent advice) — see master `AGENTS.md`

## Tech stack
- Frontend: React + Vite + Tailwind + shadcn/ui
- Backend: Express server run locally (`npm run dev`, port 5000); `api-src/index.ts` → `api/index.js` bundling kept but no longer deployed
- Database / storage: MongoDB Atlas (DB `str8stratag_db_user`, `dispatchEvents` collection). Supabase = legacy/migration only.
- Audio processing: `ffmpeg-static` via `server/audio-optimizer.ts`

## Session startup priorities (standing order, 2026-09-17)

Every time this box is fired up (especially after a reboot — the watchdog does
NOT auto-start), work in this order:

1. **Fire up the full stack.** Run the watchdog:
   `powershell -ExecutionPolicy Bypass -File C:\Users\str8s\dispatch-monitor\scripts\watchdog.ps1`
   (or `start-watchdog.bat`; run hidden). It starts Whisper, Dispatch Monitor
   (5000), and Nexus Dispatch (5001). Verify: 8178/health, :5000/api/events,
   :5001/api/events all responding before doing anything else.
2. **Review calls and tune Whisper** — listen to recent transcriptions/dispatch
   events, find recurring mis-transcriptions, and add homophone corrections to
   `HOMOPHONE_FIXES` in `whisper/whisper_service.py` (restarting Whisper after
   edits; the watchdog will do it if you kill the 8178 process).
3. **Then any other tasks.**

## Recent changes (2026-09-16) — TRIAL PASSED overnight; committed 2026-09-17, push pending

**Whisper robustness fixes (uncommitted, both dispatch-monitor and nexus-dispatch):**

1. **`whisper/whisper_service.py` — `/transcribe` changed from `async def` to `def`.**
   Why: the CPU-heavy transcription ran on the event loop and starved `/health`
   during transcribes, so the watchdog's health check timed out and kept
   restarting Whisper mid-transcription (death spiral on 2026-09-16). As a sync
   `def`, FastAPI runs it in a threadpool (faster-whisper releases the GIL in
   its C++ core), keeping `/health` responsive. The audio-read line changed
   accordingly: `await audio.read(...)` → `audio.file.read(...)`.
2. **`scripts/start-whisper.ps1` — uvicorn output redirected to `logs/whisper-service.log` / `.err.log`.**
   Why: with output inheriting the watchdog's hidden console window, fresh
   Whisper instances intermittently wedged on console writes (blocked, even
   unkillable by taskkill). Launched via `Start-Process -RedirectStandardOutput`
   because the script's `$ErrorActionPreference = "Stop"` makes the simpler
   `& python ... *>> log` form die on uvicorn's first stderr line.

**To revert (if the trial misbehaves):**
- `whisper_service.py`: `def transcribe(` → `async def transcribe(`, and
  `audio.file.read(1024 * 1024)` → `await audio.read(1024 * 1024)`.
- `scripts/start-whisper.ps1`: restore the plain
  `& $python -m uvicorn whisper_service:app --app-dir (Join-Path $repoRoot "whisper") --host 0.0.0.0 --port <port>` line.

Trial started 2026-09-16 afternoon; if stable through the night, commit and
push to both repos 2026-09-17.

## Recent changes (2026-08-18)
Commit `a570c3b`: "Wire audio upload into app with Supabase storage"

- Added `server/audio-upload.ts` — `POST /api/audio/upload`
  - Accepts an audio file via multipart form-data (`audio` field).
  - Optimizes audio with ffmpeg: 300 Hz highpass, 3500 Hz lowpass, 0 dB volume, 16 kHz, mono.
  - Uploads optimized WAV to Supabase Storage (`AUDIO_STORAGE_BUCKET`).
  - Creates a `dispatch_events` row with the public `audioUrl`.
- Added `audioUrl` to dispatch events schema, storage layer, and migration.
- Added `multer` and `@types/multer` dependencies.
- Added `AUDIO_STORAGE_BUCKET=dispatch-audio` to `.env.example`.

Commit `ce36bae`: "Add ffmpeg audio optimization for AI transcription"

- Added `server/audio-optimizer.ts` reusable utility.
- Added `scripts/optimize-audio.ts` CLI runner.
- Added `ffmpeg-static` dependency.

## Pending tasks / next steps
(none — the Vercel-deployment tasks that lived here are obsolete; Vercel retired, app runs locally on the fleet against MongoDB Atlas)

## Key commands
```bash
# Install dependencies
npm install

# Dev server
npm run dev

# TypeScript check
npm run check

# Production build (client + server for Vercel)
npm run build && node script/build-api.mjs

# Optimize a single audio file
npm run optimize-audio -- input.wav output.wav
```

## Required environment variables
```env
SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_ANON_KEY=your-supabase-anon-key
AUDIO_STORAGE_BUCKET=dispatch-audio
```

## Supabase setup
Run in Supabase SQL Editor:
```sql
ALTER TABLE dispatch_events ADD COLUMN IF NOT EXISTS audio_url text;
```

Create a public Supabase Storage bucket named `dispatch-audio` (or match `AUDIO_STORAGE_BUCKET`).

## Known issues
- ~~ffmpeg on Vercel~~ (obsolete — Vercel retired; app runs locally where `findFfmpeg()` uses system `ffmpeg` first, then the `ffmpeg-static` fallback)

## How to test audio upload
```bash
curl -X POST http://127.0.0.1:5000/api/audio/upload \
  -F "audio=@test.wav" \
  -F "transcript=Audio upload test" \
  -F "district=Tampa" \
  -F "source=Radio Feed 1"
```
