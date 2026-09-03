# Dispatch Monitor — Project Context

## Project overview
A full-stack dispatch monitoring dashboard. It captures live audio, transcribes speech, detects emergency keywords, and creates dispatch events stored in Supabase.

- Repo: `str8stratag-cmyk/dispatch-monitor`
- Local path: `C:\Users\str8s\dispatch-monitor`
- Branch: `main`
- Deployment target: Vercel

## Local runtime environment (this device)

This Windows machine is the **Whisper v3 Turbo tester** for the fleet. Other devices
(Mac, DISP-1/2) run their own Whisper models but can send transcription to this box.

- **Whisper endpoint (LAN):** `http://192.168.6.53:8178` — wired static IP on the
  TL-SG608 switch. Old wireless IP `192.168.5.251` is retired; update any device
  configs still pointing at it.
- **Model:** `turbo` (device-local, via `whisper-model.local`, gitignored). Do not
  change to `medium.en` — that is only the fallback default in the start scripts.
  Other devices run their own models (e.g. DISP-2 runs `distil-large-v3` on port 8179);
  this box is the fleet's turbo tester.
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
- **Geocoding (merged 2026-09-02):** Azure Maps is PRIMARY, Geoapify is FALLBACK.
  `.env` needs `AZURE_MAPS_KEY`; `GEOAPIFY_API_KEY`+`GEOAPIFY_BOUNDING_BOX` optional
  fallback; `GEOCODE_SUFFIX` defaults to "Tampa, FL". Optional: `ADMIN_SECRET`
  (write-endpoint auth), `WHISPER_API_KEY`/`VITE_WHISPER_API_KEY` (protects Whisper
  when LAN-exposed — if set, all fleet devices must send the `X-Whisper-Key` header).
- **Post-pull checklist (learned 2026-09-02):**
  1. `npm install` if `package.json` changed, then `npm run check`.
  2. Verify the `whisper-model.local` block survived in `scripts/start-whisper.ps1`
     (upstream removed it once already — without it this box silently boots `medium.en`).
  3. Restart services (`scripts/refresh-services.bat`) and confirm
     `/health` reports `"model":"turbo"`.
- **Known quirk:** `/health` can time out mid-transcription (CPU-bound, single
  worker). Transcription is unaffected; retry the health check.

## Tech stack
- Frontend: React + Vite + Tailwind + shadcn/ui
- Backend: Express server bundled into a Vercel serverless function (`api-src/index.ts` → `api/index.js`)
- Database / storage: Supabase (PostgreSQL + Storage)
- Audio processing: `ffmpeg-static` via `server/audio-optimizer.ts`

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
1. Verify the live Vercel deployment URL (the one previously shared returned `DEPLOYMENT_NOT_FOUND`).
2. Test `POST /api/audio/upload` on the deployed Vercel instance with a small WAV file.
3. If the upload fails on Vercel, resolve the ffmpeg runtime issue (see Known issues below).

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
- **ffmpeg on Vercel**: The `ffmpeg-static` binary installed locally is macOS ARM64. Vercel serverless functions run Linux x86_64, so the static binary may fail there. The `findFfmpeg()` helper tries system `ffmpeg` first, then falls back to the static binary. If Vercel does not provide a system `ffmpeg`, the upload endpoint will fail in production. Verify by testing the deployed `/api/audio/upload` endpoint.

## How to test audio upload
```bash
curl -X POST https://YOUR_VERCEL_URL/api/audio/upload \
  -F "audio=@test.wav" \
  -F "transcript=Audio upload test" \
  -F "district=Tampa" \
  -F "source=Radio Feed 1"
```
