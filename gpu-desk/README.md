# GPU Whisper desk (i7-8700 + RTX 2060 6GB)

Drop-in GPU replacement for the fleet's local Whisper server. It runs the **unmodified**
`dispatch-monitor/whisper/whisper_service.py` (origin/release 70f3dfb) through
`gpu_whisper_launch.py`, so the API stays the same: `POST http://127.0.0.1:8178/transcribe`
(multipart `audio`, `prompt`; optional `X-Whisper-Key`) and `GET /health`. The Chrome capture
tab and `server/whisper.ts` need no changes.

| Setting | This desk | Rest of fleet |
|---|---|---|
| Model | **medium.en** (Zach, 10/22 7:48 PM ET). `small.en` allowed via config; turbo/large refused | small.en |
| Device / compute | cuda, float16 → fallback int8_float16 (never silently to CPU) | cpu int8 |
| Beam / best_of | 2 / 2 (set `WHISPER_BEAM_SIZE`/`WHISPER_BEST_OF` in `config\gpu-desk.local`) | 2 |
| Chunk | 6 s (`VITE_CHUNK_MS=6000` in `.env.local`; loopback `CHUNK_SEC=6`) | 6 s |

medium.en in fp16 uses about 2–3 GB of VRAM, so it fits in 6 GB.

## Layout
```
gpu-desk/
├── README.md
├── scripts/   setup-gpu-desk.ps1 · start-whisper-gpu.ps1 · gpu-watchdog.ps1
├── service/   gpu_whisper_launch.py · loopback_capture.py
├── config/    requirements-gpu.txt · gpu-desk.local.example  (setup creates gpu-desk.local, untracked)
└── docs/      ARCHITECTURE.md · IMPLEMENTATION.md
```
Full design: docs/ARCHITECTURE.md. Phased plan: docs/IMPLEMENTATION.md.

## Install (once)
1. Install the NVIDIA driver (it must report CUDA 12 or newer in `nvidia-smi`). You don't need the CUDA Toolkit, because cuBLAS and cuDNN 9 come from pip.
2. `git clone -b release https://github.com/str8stratag-cmyk/dispatch-monitor C:\Users\<user>\dispatch-monitor`, `npm ci`, then set up `.env.local` the same way as the other desks.
3. Copy this package to `C:\Users\<user>\dispatch-monitor\gpu-desk\`.
4. `powershell -ExecutionPolicy Bypass -File .\gpu-desk\scripts\setup-gpu-desk.ps1` (run from the repo root)
5. Edit `gpu-desk\config\gpu-desk.local` and set **`SOURCE_NAME`**. `WHISP-1` is only a placeholder.

## One-line launch
```
powershell -ExecutionPolicy Bypass -WindowStyle Hidden -File "$env:USERPROFILE\dispatch-monitor\gpu-desk\scripts\gpu-watchdog.ps1"
```
Check it with `curl http://127.0.0.1:8178/health`. It should show `"device":"cuda"`, `"model":"medium.en"` and `"beam_size":"2"`.

## Where outputs land
- **Fleet path (unchanged):** the Chrome capture tab POSTs chunks to :8178 and gets text back. The app then
  POSTs events to `/api/dispatch`, which writes Mongo `dispatchEvents`/`quarantinedDispatches` with
  `source` = `DISP-N`. The client works that name out from the hostname via `/api/machine`, using the rule
  `STRATAGCAP<N>` → `DISP-<N>` (see FLEET-IDENTITY.md). Give the hostname a name that matches the chosen `DISP-N`.
- **Server logs (same files as the fleet):** `<repo>\logs\whisper-service.log` gets one `[text] len=.. preview=..` line
  per chunk, plus `[timing]` lines. `<repo>\logs\whisper-service.err.log` holds the uvicorn output.
- Optional audio/JSON sidecars: set `WHISPER_SAVE_AUDIO=whisper\debug-audio` in `config\gpu-desk.local`.
- **Standalone loopback capture** (`LOOPBACK_CAPTURE=on`): writes `<repo>\logs\transcripts-<SOURCE_NAME>.jsonl`
  with one `{ts, source, audioStartedAt, audioEndedAt, text, model, duration}` line per non-empty chunk. It does
  **not** create dispatch events. To list devices: `.venv-whisper\Scripts\python gpu-desk\service\loopback_capture.py --list --source X --out NUL`.
- Watchdog log: `<repo>\logs\gpu-watchdog.log`.

## Watchdog behavior
- Checks `/health` every 60 s.
- If nothing is listening on the port, it restarts right away.
- If the port is open but `/health` fails 3 times in a row, it treats that as a stall and restarts.
- It waits 240 s after a start before checking.
- It also restarts every 4 h, the same as the fleet.
- CPU fallback: after 3 failed GPU starts it runs the fleet `scripts\start-whisper.ps1` (small.en, CPU) on the same port. `/health` then shows `device: cpu`. It tries the GPU again at the next 4 h restart. Turn it off with `CPU_FALLBACK=off`.
- It restarts the loopback capture if the capture exits or its heartbeat is more than 120 s old.
- The service's own 300 s transcribe timeout and self-supervisor still apply.

**Do not also run `scripts\watchdog.ps1` unmodified on this desk.** It launches `scripts\start-whisper.ps1`, which
hard-codes CPU int8 and rewrites medium.en to small.en. The options are: (a) run only `gpu-watchdog.ps1` and start the
app/Chrome yourself, or (b) a future release change that lets the fleet watchdog call `gpu-desk\scripts\start-whisper-gpu.ps1`. Option (b) needs Zach's approval.

## Networking later (Tailscale `tailef0d8b.ts.net`)
- Join the tailnet, then the server is at `http://<desk-host>.tailef0d8b.ts.net:8178`. It already binds `0.0.0.0`.
- Other boxes can use this GPU by pointing `WHISPER_SERVICE_URL` / `VITE_WHISPER_SERVICE_URL` at it.
  The service serializes requests (1 worker), so check throughput before sharing it.
- Set `WHISPER_API_KEY` on both ends before you expose it. Limit access to port 8178 with a tailnet ACL, or a Windows
  firewall rule scoped to `100.64.0.0/10`. Don't open it on the LAN or WAN.

## WHISP-1 deployment (source of truth = this folder, release branch)
WHISP-1 runs this package from `C:\dispatch-whisper-gpu\gpu-desk` (repo root `C:\dispatch-whisper-gpu`, which is NOT a git checkout).
The scheduled task `GPU-Whisper-Watchdog` launches `scripts\gpu-watchdog.ps1` (hidden PowerShell, at logon).

To deploy or reinstall from git:
1. Get `gpu-desk/` from `origin/release`, e.g. from the `C:\Users\Test\work\dispatch-monitor` checkout: `git pull --ff-only origin release`.
2. Copy it over the live folder but **keep the per-box config**: `robocopy C:\Users\Test\work\dispatch-monitor\gpu-desk C:\dispatch-whisper-gpu\gpu-desk /E /XF *.local *.bak-*`.
3. `config\gpu-desk.local` is untracked (`*.local` in .gitignore). If it is missing, copy it from `gpu-desk.local.example`.
4. Restart only the watchdog: `Stop-ScheduledTask GPU-Whisper-Watchdog; Start-ScheduledTask GPU-Whisper-Watchdog`. If Whisper is already healthy, it is not restarted.
5. Verify: `logs\gpu-watchdog.log` shows `gpu-watchdog start restartEveryHours=0` and `http://127.0.0.1:8178/health` returns ok.

**Timed restarts stay off.** `RestartEveryHours` defaults to 0, and `RESTART_EVERY_HOURS` in `gpu-desk.local` overrides it. Don't set it above 0 on WHISP-1 unless you accept a ~30s outage for every desk on each restart. Crash restarts (nothing listening on :8178) and stall restarts (3 failed /health checks) always stay on.
