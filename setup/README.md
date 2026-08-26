# Local Dispatch Monitor + Nexus Dispatch Setup

This folder contains quick-start scripts for running the dispatch apps and the local Whisper transcription service together.

## Folder Layout

```text
C:\Users\str8s\
├── dispatch-monitor\      # Main Vercel-deployed app
├── nexus-dispatch\         # Local/offline mirror app
└── (this setup folder is inside dispatch-monitor)
```

Both apps share the same MongoDB database when `MONGODB_DB_NAME` matches in each `.env` file.

## Prerequisites

1. Node.js installed
2. MongoDB URI set in both `.env` files
3. Geoapify key set in both `.env` files (optional, falls back to Nominatim)
4. Whisper virtual environment already set up (`npm run whisper:setup` in either app)

## Quick Start

Right-click and **Run with PowerShell**:

- `start-all.ps1` — starts Whisper, dispatch-monitor, and nexus-dispatch
- `stop-all.ps1` — kills all local dispatch/Whisper processes

Or from PowerShell:

```powershell
cd C:\Users\str8s\dispatch-monitor\setup
.\start-all.ps1
```

## Ports

| Service               | Port |
|-----------------------|------|
| Whisper               | 8178 |
| dispatch-monitor      | 5000 |
| nexus-dispatch        | 5001 |

## Keeping in Sync

Run `scripts/watchdog.ps1` to automatically:
- Restart Whisper every 4 hours
- Pull GitHub updates for both repos a few times per day
- Restart apps when code changes

Run `scripts/review-calls.ps1` once a day to get a summary of odd/nonsense dispatch calls for fine-tuning.
