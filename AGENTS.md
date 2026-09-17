# Dispatch Monitor — Project Context

> **IDENTITY: THIS MACHINE IS DISP-2** (192.168.6.52). Work self-contained:
> do NOT probe or depend on other DISP devices for config or shared services —
> their DBs/services are localhost-bound and irrelevant here. When something is
> missing (e.g. MongoDB URI), the fix comes from the user or this box, not from
> poking DISP-3/Mac.

## Project overview
A full-stack dispatch monitoring dashboard. It captures live audio, transcribes speech, detects emergency keywords, and creates dispatch events stored in MongoDB Atlas.

- Repo: `str8stratag-cmyk/dispatch-monitor`
- Local path: `C:\Users\str8s\dispatch-monitor`
- Branch: `main`
- Deployment: **Vercel retired** (switched to MongoDB Atlas + locally-run apps on the fleet, at agent advice) — see master `AGENTS.md`

## Local runtime environment (this device)

This Windows machine (**DISP-2**) is the **Whisper v3 Turbo tester** for the fleet.
Other devices (Mac, DISP-1, DISP-3) run their own Whisper models but can send
transcription to this box.

**MongoDB (RESOLVED 2026-09-04):** the app is MongoDB-only (migrated from Supabase).
Shared fleet cluster: **MongoDB Atlas** (`mongodb+srv`, host `nexus-disp.dndtjvg.
mongodb.net`, db `str8stratag_db_user`) — the SAME database all DISP devices write
to (that's how the reconciler dedups across devices). Credentials live ONLY in each
repo's `.env` (gitignored) — NEVER commit them, never write them into this file.
If `.env` ever loses them, ask the user; do not hunt for MongoDB on other devices.

- **Whisper endpoint (LAN):** `http://192.168.6.52:8178` — THIS machine's wired IP on
  the TL-SG608 switch (verified 2026-09-02; the earlier report claiming `.53` was
  wrong). `192.168.6.53` is a DIFFERENT device (MAC 04-7b-cb-a3-6c-ed) running its own
  Whisper on `medium.en` — devices pointed at `.53` are NOT using this box's turbo.
  Old wireless IP `192.168.5.251` is retired.

**Fleet map (confirmed 2026-09-03):**
| Device | IP | Role |
|--------|----|------|
| **DISP-2 (this machine)** | 192.168.6.52 | Whisper v3 turbo tester, dispatch :5000, nexus :5001 |
| DISP-3 | 192.168.6.53 | Whisper medium.en, watchdog-managed (4h restart, 6h git pull), runs `trial/` reconciler every 3 min |

Status reports mentioning "medium.en, watchdog-managed, reconciler, .53" come from the
DISP-3 box — do not mistake them for this machine's state. The Azure Maps account
(Client ID 65434727-…) is shared across the fleet; this machine uses the same key
(stored in `.env`, gitignored).

## Local vs shared (READ FIRST)

**DO NOT `git push` from this machine without the user's explicit say-so.**

- Unpushed local commits (as of 2026-09-03): dispatch-monitor **ahead 7**,
  nexus-dispatch **ahead 4**.
- **EXCEPTION (pushed 2026-09-10, user-approved):** the MongoDB
  server-selection fix (clear the cached `getDatabase()` promise on failure
  so one transient Atlas blip can't poison every DB request until restart)
  was squash-merged to both repos' `main` as PR #1 (dispatch-monitor
  `96da4cc`, nexus-dispatch `5782ff4`). First fleet-shared code from this
  box; everything else below remains local-only.
- **EXCEPTION (merged 2026-09-16, user-approved):** fleet update squash-merged
  to both repos' `main` (dispatch-monitor `edb8420`, nexus-dispatch
  `ad86f2b`): quarantine + restore, road-mention second-signal gate,
  whisperModel tagging, geocode suffix fix (both repos), nexus Azure-primary
  geocoder + creation-time pinning, and `FLEET_PULL_2026-09-16.md` runbooks.
  Fleet devices auto-apply via their watchdog pull/restart cycle. AGENT
  NOTE: the user never runs git pulls on this box — sessions do. Never
  blind-pull here: local main diverged from the rewritten origin/main (same
  changes exist as local commits AND as uncommitted working-tree edits the
  running services serve from). Commit working-tree changes first, then
  `git merge origin/main`, resolve shared-code conflicts deliberately
  (upstream side for squash-merged features, local side for intentional
  adaptations like cross-env/LAN binds), then npm install + check + service
  refresh. Full procedure in KIMI_RESUME.md (AGENT NOTE, 2026-09-16).
- **Policy (user decision 2026-09-03):** turbo stays on DISP-2 as the tester.
  If it keeps getting good results, the user will share it with the other DISP
  devices. Until then: no pushes.
- When sharing IS approved, push ONLY: (1) the model-selection mechanism
  (the `whisper-model.local` block in `scripts/start-whisper.ps1`), and (2) the
  `whisperModel` event tagging (schema + storage + whisper.ts + routes stamp +
  whisper_service.py response). Do NOT push: the helper bats / detached start
  scripts (upstream deleted those on purpose), or this AGENTS.md (machine-specific).
- **QA tooling (added 2026-09-04, local-only until push approved):**
  - `node scripts/accuracy-by-source.mjs [hours]` — per-source event stats from
    Atlas (count, avg transcript length, no-keyword %, no-coords %). First run
    (72h): DISP-3/medium.en 74% no-keyword vs 0% for DISP2/turbo and others.
  - `powershell -ExecutionPolicy Bypass -File scripts\regression-check.ps1` —
    transcribes `test-audio.wav`, diffs vs `test-audio.expected.txt`. PASS = no
    drift. Use `-UpdateBaseline` only after an intentional model/params change.
  - Baseline 2026-09-04 (turbo, beam 5): "Unit 1 responding to emergency at Main
    Street and Fifth Avenue. Suspect is fleeing northbound on foot."
- **Autostart:** Task Scheduler task `Dispatch Services Autostart` runs
  `scripts\refresh-services.bat` at user logon (registered 2026-09-04; refresh bat
  now starts/stops all three services incl. Nexus :5001). After a reboot, services
  come up on login — verify with the health checks if anything seems down.
- Never travels via git (gitignored): `whisper-model.local`, `.env` (Azure Maps
  key), `KIMI_RESUME.md`, logs, `test-audio.wav`.
- After ANY future `git pull`, run the post-pull checklist below — upstream
  removed the `whisper-model.local` block once already.
- **Model:** `turbo` (device-local, via `whisper-model.local`, gitignored). Do not
  change to `medium.en` — that is only the fallback default in the start scripts.
  This box IS DISP-2 and runs turbo; other devices run their own models. Note:
  `nexus-dispatch/start-whisper-disp2.bat` (distil-large-v3, port 8179) came from the
  fleet's shared repo — it is NOT this box's config and should not be run here.
- **Whisper bind:** `0.0.0.0:8178` in BOTH `scripts/start-whisper.ps1` and
  `scripts/start-whisper-detached.ps1` — keep them consistent or LAN access breaks.
- **Firewall:** inbound TCP 8178 must be allowed (rule name `Whisper v3 Turbo (8178)`).
  Adding it requires an elevated shell:
  `netsh advfirewall firewall add rule name="Whisper v3 Turbo (8178)" dir=in action=allow protocol=TCP localport=8178`
- **Services:** Whisper `:8178`, Dispatch Monitor `:5000`, Nexus Dispatch `:5001`.
  Start/stop via Desktop `Refresh Dispatch Services.bat` / `Kill Dispatch Services.bat`
  or `scripts/refresh-services.bat` (Git-Bash safe) / `scripts/kill-services.bat`.
  NOTE: `refresh-services.bat`/`kill-services.bat` and both `*-detached.ps1` scripts
  are LOCAL-ONLY (upstream deleted them in favor of the watchdog flow — kept here
  because the Desktop shortcuts depend on them). Their kill patterns match `:8178`/`:5000`
  on ANY binding; if you edit the bind host, keep these patterns in sync.
- **Watchdog:** upstream flow is `start-watchdog.bat` → `scripts/watchdog.ps1`
  (starts all three services hidden, restarts Whisper every 4h, `git pull` every 6h).
  NOT auto-started on this box. Health check is `GET /health` (30s timeout).
  When active it starts Whisper via `start-whisper.ps1`, which reads
  `whisper-model.local` → stays on turbo.
  LOCAL CHANGE (2026-09-04): after a pull updates a repo, the watchdog runs
  `npm install` for that repo BEFORE restarting its app — prevents the
  missing-dependency crash (e.g. `express-rate-limit`) on post-pull restarts.
  If pushing the watchdog upstream later, keep this addition.
- **Geocoding (merged 2026-09-02):** Azure Maps is PRIMARY, Geoapify is FALLBACK.
  `.env` needs `AZURE_MAPS_KEY`; `GEOAPIFY_API_KEY`+`GEOAPIFY_BOUNDING_BOX` optional
  fallback; `GEOCODE_SUFFIX` defaults to "Tampa, FL". Optional: `ADMIN_SECRET`
  (write-endpoint auth), `WHISPER_API_KEY`/`VITE_WHISPER_API_KEY` (protects Whisper
  when LAN-exposed — if set, all fleet devices must send the `X-Whisper-Key` header).
  DECISION (2026-09-02): `WHISPER_API_KEY` stays UNSET on this machine — Whisper is
  our own local/LAN service, no key. Do not add one; fleet devices call it bare.
- **Post-pull checklist (learned 2026-09-02):**
  1. `npm install` if `package.json` changed, then `npm run check`.
  2. Verify the `whisper-model.local` block survived in `scripts/start-whisper.ps1`
     (upstream removed it once already — without it this box silently boots `medium.en`).
  3. Restart services (`scripts/refresh-services.bat`) and confirm
     `/health` reports `"model":"turbo"`.
- **Known quirk:** `/health` can time out mid-transcription (CPU-bound, single
  worker). Transcription is unaffected; retry the health check.
- **Road Mentions (tuned 2026-09-12):** "Road Mention" events (major road
  named, no crash keyword) were ~48% of all events. They now require a second
  signal server-side (POST /api/dispatch, auto-dispatches only): dispatch
  context in the same transmission (unit/responding/10-codes/etc., see
  ROAD_MENTION_CONTEXT_RE) OR the same road active in an event within 45 min
  (roadMentionedRecently). Context-free mentions are quarantined with reason
  "road mention lacks corroborating signal" — reviewable via /api/quarantine,
  recoverable via restore. Manual dispatches unaffected. MERGED to
  origin/main 2026-09-16 (squash commit `edb8420`, user-approved).
- **Geocoding (fixed 2026-09-16; MERGED to origin/main — fleet auto-rollout):** (1) `getGeocodeQuery` in BOTH repos suppressed the ", Tampa, FL" suffix whenever the address contained the substring "florida" — so every "Florida Ave" extract (from "Florida tag" phonetic chatter) geocoded bare, hit out-of-state Azure results, and got rejected by the FL bounds check (57% of missing pins fleet-wide). The FL/Florida match must now anchor to the END of the address (", FL" / ", Florida" / optional ZIP). (2) nexus-dispatch `/api/dispatch` never geocoded at creation — manual entries arrive lat/lng null and were stored coord-less; it now shares dispatch-monitor's `geocodeAddress` helper (Azure → Geoapify → Nominatim) wired into creation. Merged to origin/main 2026-09-16 as squash commits (dispatch `edb8420`, nexus `ad86f2b`, user-approved; fleet branches deleted after content-verified merge). Runbook the other boxes read on pull: `FLEET_PULL_2026-09-16.md` in both repo roots.
- **Keywords (lesson 2026-09-12, from the DISP-4 fleet review):** never add
  hallucination-prone strings as keywords. "nba"/"nbc" had been added to catch
  MVA/MVC mishearings and Whisper invents them on squelch noise, so every
  noise burst became an MVA dispatch trigger. Removed them (27→25 keywords;
  keyword_list lives in shared Mongo). Fix mishearings via the homophone
  table instead.
- **Whisper initial_prompt (fixed 2026-09-08):** the transcription prompt sent by
  `server/whisper.ts` and `client/src/hooks/use-audio-capture.ts` must stay
  GENERIC (domain words only, no concrete call). A hardcoded example
  ("Signal 4, MVA at Dale Mabry and Linebaugh") made Whisper hallucinate that
  exact call into ~300 unrelated events over one weekend. Never put a specific
  address/signal in the prompt. Upstream/fleet copies may still carry the bad
  prompt — they need the same fix.

## Tech stack
- Frontend: React + Vite + Tailwind + shadcn/ui
- Backend: Express server run locally (`npm run dev`, port 5000); `api-src/index.ts` → `api/index.js` bundling kept but no longer deployed
- Database / storage: MongoDB Atlas (DB `str8stratag_db_user`, `dispatchEvents` collection). Supabase = legacy/migration only.
- Audio processing: `ffmpeg-static` via `server/audio-optimizer.ts`

## Session startup priorities (standing order, 2026-09-17)

Every time this box is fired up (especially after a reboot — the watchdog does
NOT auto-start), work in this order:

1. **Fire up the full stack.** ON THIS BOX the watchdog is intentionally
   not the startup path — use `scripts\refresh-services.bat` (Desktop
   shortcuts; Task Scheduler `Dispatch Services Autostart` covers logon).
   It starts Whisper (8178), Dispatch Monitor (5000), Nexus Dispatch
   (5001). Verify: 8178/health, :5000/api/events, :5001/api/events all
   responding before doing anything else. Full ritual (calls review,
   Whisper tuning order): see `KIMI_RESUME.md` → "Session Startup Ritual".
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
