# Dispatch Monitor — Project Context

## Project overview
A full-stack dispatch monitoring dashboard. It captures live audio, transcribes speech, detects emergency keywords, and creates dispatch events stored in Supabase.

- Repo: `str8stratag-cmyk/dispatch-monitor`
- Local path: `/tmp/dispatch-monitor`
- Branch: `main`
- Deployment target: Vercel

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
