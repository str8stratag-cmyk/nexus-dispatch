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

Every time this box is fired up, work in this order:

1. **Check the stack — don't blindly start it.** The watchdog auto-starts at
   logon via `dispatch-watchdog.vbs` in the Startup folder (added 2026-09-14).
   First check for a running watchdog (powershell processes with `watchdog.ps1`
   in the command line) and verify 8178/health and :5000/api/events are
   responding before doing anything else (nexus :5001 RETIRED 2026-09-18 —
   push-only mirror, never run). Only if the watchdog is missing, launch ONE, hidden:
   `powershell -ExecutionPolicy Bypass -File C:\Users\str8s\dispatch-monitor\scripts\watchdog.ps1`
   NEVER start a second watchdog (e.g. `start-watchdog.bat`) while one is
   running — two watchdogs race restarts and wedge the apps.
   App output now goes to `dispatch-monitor\logs\dispatch-monitor.log` and
   `nexus-dispatch\logs\nexus-dispatch.log` — if an app won't bind its port,
   check those logs first. A healthy Whisper instance shows TWO python.exe
   processes (the `.venv-whisper` launcher and the real interpreter it spawns)
   — killing the launcher kills the service.

## Recent changes (2026-09-18) — HOMOPHONE_FIXES tuned; committed f2bebdb, pushed

Also landed same day from another box (c34c790, rebased under f2bebdb):
Whisper self-supervisor thread (probes /health every 30s, `os._exit(1)`
after 5 min of transcribe-requested-but-never-completing — DISP-1 hung 16h
serving TCP but never replying), watchdog self-update on pull, and a
capture-failure banner in the client.

Morning call review (last 500 events) added 12 corrections to
`HOMOPHONE_FIXES` in `whisper/whisper_service.py`. Heavy hitters:
"florida tech"/"flirtag" → "Florida tag" (16 plate-read hits),
"bush" → "Busch" (24 hits — Tampa's Busch Blvd; literal-shrubbery false
positives are rare and harmless), "McKinney/McKinvey/MCKINNELY" →
"McKinley", "McDill/McDILLL" → "MacDill", plus one-off street garbles
(cyprus(s)→Cypress, osbourne→Osborne, arbenia→Armenia, ashely→Ashley,
interstte→Interstate, signaal→Signal, unkown→unknown). Verified with
py_compile + a direct apply_homophone_fixes test.

**Afternoon: "AZEELE AMD TAMPANIA" geocode miss diagnosed + fixed** (event
862, Telegram alert with the approximate-location banner). Azure Maps was
never asked a valid question: DISP-5's pipeline sent address "AZEELE AMD
TAMPANIA" ("and" mis-heard as "amd"), `INTERSECTION_SPLIT_RE` didn't know
"amd", so Azure got one fictitious street and returned nothing; both roads
were also missing from `KNOWN_ROAD_CANONICAL`, and Azure's intersection
matching wants a street-type suffix on at least one side anyway. Fixes in
`server/routes.ts`: "amd" added to the joiner regex, canonical entries
`Azeele St` / `Tampania Ave` (both real Tampa roads, 33606/33609 — Azure
had them all along). Plus whisper `\bamd\b` → "and". E2E-verified on the
live box: `/api/geocode?q=AZEELE AMD TAMPANIA` →
"Azeele St & S Tampania Ave, Tampa, FL 33609" from Azure. Note there is NO
local road dataset — every address is a live Azure→Geoapify→Nominatim
query with ", Tampa, FL" appended.

- **Elevation gotcha:** the logon watchdog and the Whisper it spawns run
  ELEVATED, so a non-elevated shell CANNOT kill the 8178 python
  (taskkill/Stop-Process = Access denied). To apply whisper_service.py
  edits before the watchdog's scheduled 4h restart, kill 8178 from an
  ELEVATED prompt; otherwise edits load at the next scheduled restart.
- **nexus-dispatch = push-only parity mirror, NOT run anywhere** (user,
  2026-09-18): all updates get pushed to it, but nothing pulls and runs it;
  live production is dispatch-monitor only. Later the same day the user
  clarified nexus is never run on any box: the :5001 restart block was
  removed from `watchdog-disp3.ps1` and RUNBOOK/AGENTS startup checks no
  longer verify :5001. Its `whisper_service.py` had drifted — missing
  the 2026-09-16/17 robustness work entirely — so it was re-synced by copying
  dispatch-monitor's file over it on 2026-09-18. `start-whisper.ps1`
  intentionally differs there (shared-venv fallback to dispatch-monitor's
  `.venv-whisper`, `WHISPER_PORT` env override) — keep those lines when
  porting script changes.

## Recent changes (2026-09-17) — committed 9ef465a, pushed

- `server/routes.ts`: removed `dispatch radio terminology` from
  `HARD_PRODUCTION_PHRASES`. It is the literal start of the Whisper
  `initial_prompt`, so prompt-echo transcriptions tripped the production-audio
  ban and got quarantined. Side effect: prompt echo can now create junk events
  (echo carries "Local street names: Olla" + keyword patterns). The cleaner
  lever is rewording the prompt in `client/src/hooks/use-audio-capture.ts` and
  `server/whisper.ts`.
- `scripts/watchdog.ps1`: app stdout/stderr redirected to log files. Apps
  inheriting the watchdog's hidden console intermittently wedged on console
  writes and never bound their port (same failure mode Whisper had).
- `scripts/watchdog.ps1`: TWO dead-app-recovery bugs fixed 2026-09-17.
  `Get-Date - $lastAppRestart[$title]` parsed `-` as a parameter, making the
  restart throttle null-always-true — the watchdog could never restart a dead
  app. Also `GIT_TERMINAL_PROMPT=0` so a credential prompt can't wedge the
  loop. Watchdog's own output should be launched with redirection to
  `logs\watchdog.log` for observability.
2. **Review calls and tune Whisper** — listen to recent transcriptions/dispatch
   events, find recurring mis-transcriptions, and add homophone corrections to
   `HOMOPHONE_FIXES` in `whisper/whisper_service.py` (restarting Whisper after
   edits; the watchdog will do it if you kill the 8178 process).
3. **Then any other tasks.**

## Recent changes (2026-09-16) — TRIAL PASSED overnight; committed 2026-09-17, pushed

**Whisper robustness fixes (both dispatch-monitor and nexus-dispatch):**

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
- **nexus-dispatch `server/routes.ts` is a full server fork, massively
  drifted** (found 2026-09-18): it predates the quarantine system, dedup,
  `HARD_PRODUCTION_PHRASES`, road-mention tuning, whisperModel stamping,
  the new `atlas.microsoft.com/geocode` API (still on 2023-06-01 reverse
  endpoint), and the Telegram approximate-location banner. The nexus app on
  :5001 runs this old code. Decision pending: full routes.ts parity swap
  (risky-ish, it's the running :5001 app) vs leave as-is since nexus is not
  production. The 2026-09-18 geocode fixes were applied to BOTH versions.
- Refire technique that works from a non-elevated shell: write a kill-ports
  ps1, launch it with `Start-Process -Verb RunAs` (UAC click), let the
  watchdog do the rest. `schtasks /rl HIGHEST` is denied non-elevated.

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
