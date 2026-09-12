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
