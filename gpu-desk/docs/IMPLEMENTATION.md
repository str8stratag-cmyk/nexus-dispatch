# GPU Whisper Desk: Implementation Plan

Each phase has an exit check. Stop at the first failure. Nothing changes on the fleet or `release` without Zach's explicit approval.

## Phase 0: Hardware prep
1. **Dead fan:** replace the failed GPU fan, or the case fan if that is the one that failed, **before** any sustained load. Confirm by watching GPU temperature at idle and under load: `nvidia-smi --query-gpu=temperature.gpu,fan.speed,clocks.sm,power.draw --format=csv -l 5`.
   - Target: under 80 °C sustained, with no `HW Slowdown` or `Thermal` throttle reason (`nvidia-smi -q -d PERFORMANCE`).
   - Do not run the trial or fleet traffic on this desk until the temperatures are confirmed.
2. Clean dust from the heatsinks. Check that the PSU is adequate (2060: about 160 W; i7-8700: 65 W). Make sure the PCIe power connector is seated.
3. Windows 10/11 x64 fully updated. Set the High Performance power plan. Disable sleep and hibernate.
4. Set the hostname to match the chosen fleet name (Q1), e.g. `WHISP-1` → `WHISP-1`.

**Exit:** the desk stays stable for 30 min under a GPU stress test without thermal throttling.

## Phase 1: Drivers and base software
1. Install the latest NVIDIA Studio or Game Ready driver. Check that `nvidia-smi` shows `CUDA Version: 12.x` or later. The CUDA Toolkit is not required.
2. Install Git, Node LTS, and Chrome, the same as the other desks. Python 3.12 is installed by setup.
3. Install Tailscale and join `tailef0d8b.ts.net`. Record the MagicDNS name and 100.x IP in FLEET-IDENTITY.md through a later PR.
4. Clone: `git clone -b release https://github.com/str8stratag-cmyk/dispatch-monitor %USERPROFILE%\dispatch-monitor`, then `npm ci`. Copy `.env.local` from the fleet using the usual secure channel. Never paste it into chats or logs.

**Exit:** the app starts on `:5000` using the fleet CPU Whisper, which proves the base install works.

## Phase 2: GPU Whisper setup
1. Copy this package to `%USERPROFILE%\dispatch-monitor\gpu-desk\`.
2. Run `powershell -ExecutionPolicy Bypass -File .\gpu-desk\scripts\setup-gpu-desk.ps1`. It:
   - checks the GPU,
   - creates the venv,
   - installs the cuBLAS and cuDNN wheels,
   - loads medium.en on CUDA,
   - writes `config\gpu-desk.local`,
   - adds `VITE_CHUNK_MS=6000` to `.env.local` if missing.
3. Edit `config\gpu-desk.local`: set `SOURCE_NAME` and the beam.
4. Launch: `powershell -ExecutionPolicy Bypass -WindowStyle Hidden -File "$env:USERPROFILE\dispatch-monitor\gpu-desk\scripts\gpu-watchdog.ps1"`.
5. Autostart: create a Task Scheduler entry that runs at logon with that command (the same pattern as fleet watchdog autostart). Start the app and Chrome as the fleet does (`setup\start-all.ps1`). Don't start the fleet watchdog's Whisper (see Q3).

**Exit:** `curl http://127.0.0.1:8178/health` returns `device: cuda`, `model: medium.en`, `compute_type: float16`, `beam_size: 2`.

## Phase 3: Validation tests
| # | Test | Pass criterion |
|---|---|---|
| V1 | `curl -F audio=@test-audio.wav http://127.0.0.1:8178/transcribe` (repo `test-audio.wav`) | Text matches `test-audio.expected.txt` closely, with `model: medium.en` |
| V2 | Latency: 50 chunks of 6 s; read `[timing] transcribe=` from `logs\whisper-service.log` | p95 under 1.5 s at beam 2 (record beam 5 too) |
| V3 | Chrome capture tab live for 2 h with real radio audio | Events appear in Mongo with the correct `source`, and quarantine noise is no worse than the CPU desks |
| V4 | Crash: `taskkill /F` the whisper python | Watchdog restarts it in 60 s or less (logged) |
| V5 | Stall: suspend the process (e.g. Process Explorer suspend) | Restart after about 3 failed checks |
| V6 | CPU fallback: rename `.venv-whisper\Lib\site-packages\nvidia` temporarily | After 3 failed starts, `/health` shows `device: cpu`, small.en. Undo the rename; the GPU comes back at the next 4 h restart or a watchdog restart |
| V7 | Thermal: 1 h at sustained load (V2 loop) | Under 80 °C, no throttling |
| V8 | Loopback (optional): `LOOPBACK_CAPTURE=on` | `logs\transcripts-<SOURCE>.jsonl` fills with text, and the heartbeat stays fresh |
| V9 | Remote: from another box, run `curl` with and without `X-Whisper-Key` once the key is set | 401 without the key, 200 with it |

## Phase 4: Trial on DISP-4 (central GPU server)
- **Current state (as briefed):** DISP-4 points to `http://192.168.1.129:8178`. That server runs medium.en on CUDA with beam 5. The rollback script is `C:\gpu-trial-rollback.ps1` on DISP-4.
1. Before relying on the trial, confirm the server's config: `/health` should show `beam_size: 5`, `device: cuda`. Confirm the firewall scope and that `WHISPER_API_KEY` is set on the server and in DISP-4's `.env.local`.
2. Run for at least 48 h. Compare DISP-4's events and quarantines with the other desks over the same hours. Watch the GPU desk's `[timing]` lines and temperatures.
3. **Rollback:** on DISP-4, run `powershell -ExecutionPolicy Bypass -File C:\gpu-trial-rollback.ps1`. It points DISP-4 back to local CPU Whisper. Then restart the app and Chrome, and confirm DISP-4's local `/health` shows `cpu` and that events flow.
4. Prefer the Tailscale MagicDNS address over 192.168.1.129 if the LAN IP can change.

**Exit:** Zach decides whether to expand, based on accuracy, latency, and stability.

## Phase 5: Fleet rollout (PR, only with Zach's approval)
1. Open a PR against `main` (never push to `release` directly). It would:
   - add `gpu-desk/` to the repo,
   - teach `scripts\watchdog.ps1` to call `gpu-desk\scripts\start-whisper-gpu.ps1` when `watchdog.local` has `WHISPER_GPU=1`,
   - make `start-whisper.ps1`'s small.en enforcement skip GPU boxes,
   - update FLEET-IDENTITY.md with the new desk.
2. Zach reviews and merges. He then promotes `main → release` with `scripts\promote-release.ps1`. The desks pick it up on the normal 4–6 h pull.
3. Move other desks to the central GPU one at a time, by editing each desk's `.env.local` URL and key. Keep the local CPU Whisper installed as the rollback path.

## Phase 6: Rollback (any phase)
- **GPU desk:** stop `gpu-watchdog.ps1`, then run the fleet `scripts\start-whisper.ps1` (CPU small.en) or the fleet watchdog.
- **Remote desks:** `C:\gpu-trial-rollback.ps1` (DISP-4), or reset `VITE_WHISPER_SERVICE_URL` / `WHISPER_SERVICE_URL` to `http://127.0.0.1:8178` and restart the app.
- **Fleet code:** revert the PR on `main` and promote again (as was done with #68 for #67).

## Open questions
- **Q1:** Fleet name and hostname for the GPU desk. WHISP-1 is a placeholder.
- **Q2:** Is 192.168.1.129 this new desk or a different machine? The documented fleet subnets are 192.168.6.x and 192.168.4.x.
- **Q3:** Supervision on the GPU desk: run `gpu-watchdog.ps1` alone and start the app/Chrome yourself, or change the fleet watchdog (Phase 5)?
- **Q4:** Beam: 2 (this package's default) or 5 (the DISP-4 trial)? Decide from the V2 numbers.
- **Q5:** Should the GPU desk also capture its own radio feed, or only serve other desks?
- **Q6:** Key distribution for `WHISPER_API_KEY` across desks. Rotation plan.
- **Q7:** Should desks fall back automatically to local CPU when the central GPU is down? This would need a client change.
- **Q8:** Contents of `C:\gpu-trial-rollback.ps1` have not been reviewed.
