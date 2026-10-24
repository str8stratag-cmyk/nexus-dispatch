# GPU Whisper Desk: Architecture

Baseline: `dispatch-monitor` origin/release **70f3dfb**. Hardware: Intel i7-8700, NVIDIA RTX 2060 6 GB.

## 1. Goals and constraints
- Keep the fleet Whisper API exactly as it is: `:8178` `POST /transcribe` and `GET /health`. No client or app changes.
- Run the **unmodified** `whisper/whisper_service.py`. The GPU desk only changes environment and launcher settings.
- Model policy:
  - This desk uses **medium.en** (Zach, 2026-10-22). small.en is allowed if configured.
  - turbo and large-v3 are refused.
  - The rest of the fleet stays on small.en, CPU, int8.
- Device `cuda`, `float16`, falling back to `int8_float16`. Beam 2 by default (configurable). 6 s chunks.

## 2. Components
| Component | Location | Role |
|---|---|---|
| Chrome capture tab | `client/src/hooks/use-audio-capture.ts` (fleet) | Records a mic or line-in in `audio/webm` chunks (`VITE_CHUNK_MS=6000`), skips silent chunks, POSTs to `VITE_WHISPER_SERVICE_URL` (default `http://127.0.0.1:8178`). Keeps 2 chunks queued and sends one at a time. |
| GPU Whisper server | `service/gpu_whisper_launch.py` → fleet `whisper/whisper_service.py` | FastAPI/uvicorn on `0.0.0.0:8178`, using faster-whisper 1.2.1 / CTranslate2 4.x on CUDA 12 with cuDNN 9 (pip wheels). It loads the model at import and tries each compute type in order. If none works it exits with code 2 and does **not** fall back to CPU silently. |
| Launcher | `scripts/start-whisper-gpu.ps1` | GPU version of `scripts/start-whisper.ps1`. Uses the same venv (`.venv-whisper`), `HF_HOME=<repo>\models`, the same log files, and a hidden `Start-Process` that writes to files. |
| Watchdog | `scripts/gpu-watchdog.ps1` | Keeps the service healthy, falls back to CPU, scheduled restarts, and supervises the optional capture. See §4. |
| Loopback capture (optional) | `service/loopback_capture.py` | Records system audio through WASAPI loopback (or a mic) in 6 s WAV chunks, POSTs them to `:8178`, and writes `logs\transcripts-<SOURCE>.jsonl`. It does **not** create events. |
| Dispatch Monitor app | `server/routes.ts` (fleet, `:5000`) | Gets the transcript text from the tab, extracts events and addresses, and runs quarantine. Writes to MongoDB. |
| MongoDB | Atlas (fleet) | Collections `dispatchEvents` and `quarantinedDispatches`. `source` = `DISP-N`. |

## 3. Data flow
```mermaid
flowchart LR
  subgraph Desk["GPU desk (RTX 2060)"]
    A[Radio / scanner audio] --> B[Chrome capture tab<br/>MediaRecorder 6s webm]
    A -.optional.-> L[loopback_capture.py<br/>WASAPI 6s wav]
    B -- "POST /transcribe (audio, prompt, X-Whisper-Key)" --> W["GPU Whisper :8178<br/>medium.en cuda fp16, beam 2"]
    L -- "POST /transcribe" --> W
    W -- "{text, segments, model}" --> B
    W -- "{text}" --> J[(logs/transcripts-SOURCE.jsonl)]
    W --> WL[(logs/whisper-service.log<br/>[text] [timing])]
    B -- "transcript + source DISP-N" --> APP[Dispatch Monitor app :5000<br/>event + address extraction]
    WD[gpu-watchdog.ps1] -. "/health every 60s, restart" .-> W
  end
  APP -- "POST /api/dispatch → insert" --> M[(MongoDB Atlas<br/>dispatchEvents / quarantinedDispatches)]
  subgraph Others["Other desks (optional, LAN/Tailscale)"]
    D4[DISP-4 Chrome tab] -- "POST http://192.168.1.129:8178/transcribe" --> W
  end
```

The fleet sets the source name automatically. `GET /api/machine` returns the hostname, and the client maps `STRATAGCAP<N>` to `DISP-<N>` (see FLEET-IDENTITY.md). The GPU desk's hostname has to match whatever DISP name Zach chooses.

The server **ignores the request `prompt`** by design (`CLEAN_PROMPT=None`, a fix for prompt-echo hallucinations). Text fixes such as homophones, repetition trimming, and the nsp/compression-ratio drop are identical to the fleet.

## 4. Watchdog design (`scripts/gpu-watchdog.ps1`)
- **Loop:** every 60 s it calls `GET /health` with a 30 s timeout. The fleet CPU watchdog uses 60 s because its CPU boxes respond slowly.
- **Crash:** if nothing is LISTENING on `:8178`, it restarts immediately.
- **Stall:** if the port is open but `/health` fails 3 checks in a row, it kills the port's PID and any `gpu_whisper_launch.py` processes, then restarts.
- **Boot grace:** it skips checks for 240 s after a start, because the first medium.en download and load are slow.
- **Scheduled restart:** every 4 h, matching the fleet. A scheduled restart also resets the GPU failure count, so a desk running on CPU fallback tries the GPU again.
- **In-service backstops** come from the fleet code: a 300 s transcribe timeout calls `os._exit(1)`, and a self-supervisor kills the process if `/health` stays dead while requests are queued. The watchdog then relaunches.
- **Fallback to CPU Whisper:** when `CPU_FALLBACK=on` and the GPU fails to become healthy more than `CPU_FALLBACK_AFTER` (3) starts in a row, the watchdog runs the fleet `scripts\start-whisper.ps1` (small.en, cpu, int8, same port and API). The `/health` `device` field then reads `cpu`, which makes the fallback visible, and the watchdog log records it. Typical causes are a driver update, an overheated or throttled GPU (dead fan), or missing cuDNN DLLs.
- **Capture supervision:** if `LOOPBACK_CAPTURE=on`, it restarts the capture when the process exits or the `.heartbeat` file is older than 120 s.
- **Logs:** `logs\gpu-watchdog.log`. Logs rotate at 50 MB (`.1`).
- **Conflict:** the fleet `scripts\watchdog.ps1` always starts the CPU server (`start-whisper.ps1` forces cpu int8 small.en). Do **not** run both against Whisper on this desk. The app and Chrome supervision in the fleet watchdog is not duplicated here. Options are listed in IMPLEMENTATION.md, open question Q3.

## 5. Networking: a central GPU server for other desks
- The server binds to `0.0.0.0:8178`. Other desks use it by setting `VITE_WHISPER_SERVICE_URL` (Chrome tab) and `WHISPER_SERVICE_URL` (server side) in their untracked `.env.local`, then restarting the app.
- **LAN:** for example `http://192.168.1.129:8178`. The documented fleet subnets are 192.168.6.x and 192.168.4.x, so check whether 192.168.1.x can be reached from each desk.
- **Tailscale (tailnet `tailef0d8b.ts.net`):** `http://<gpu-host>.tailef0d8b.ts.net:8178` (MagicDNS) or the desk's `100.x` IP. This is stable across DHCP and subnet changes and is the preferred long-term address.
- **Current DISP-4 trial (as briefed):**
  - DISP-4's capture points at `http://192.168.1.129:8178`. That server runs medium.en on CUDA with **beam 5**. The default in this package is beam 2; set `WHISPER_BEAM_SIZE=5` and `WHISPER_BEST_OF=5` in `config\gpu-desk.local` to match.
  - Rollback script on DISP-4: `C:\gpu-trial-rollback.ps1`. It points DISP-4 back to its local CPU Whisper. I have not reviewed its contents.
- **Failure mode:** a remote desk has no automatic failover. If the GPU server is down, the client shows "Local Whisper is NOT RESPONDING" after 3 failures, and the DISP-4 watchdog keeps its local CPU Whisper healthy but unused. The fix is to roll back, or (future work) add a client-side fallback URL.

## 6. Security
- **`WHISPER_API_KEY`:**
  - The server rejects `/transcribe` requests whose `X-Whisper-Key` doesn't match (`compare_digest`).
  - Clients send it via `VITE_WHISPER_API_KEY` (browser) and `WHISPER_API_KEY` (server). These must be set **before** any remote desk uses this server.
  - Store it as a machine environment variable or in untracked `.env.local`. Never put it in the repo, `gpu-desk.local`, or logs.
  - `/health` is unauthenticated and reveals only configuration.
- **Network exposure:** limit inbound TCP 8178 with a Windows Firewall rule scoped to the fleet LAN /24 and/or `100.64.0.0/10` (Tailscale), plus a tailnet ACL. Never forward the port to the internet.
- CORS is open in the fleet service. That is acceptable only because exposure is limited to LAN/tailnet and the key is required.
- The browser key (`VITE_`) is visible to anyone using the capture page. It protects the network path, not against desk operators.

## 7. Capacity and concurrency
- The service serializes inference with a single-worker `ThreadPoolExecutor`, so one GPU server handles one chunk at a time.
- **Rough estimates, not yet measured:** RTX 2060, medium.en fp16, beam 2, 6 s chunk: about 0.4–0.8 s per chunk (roughly 8–15× real time). Beam 5 is about 1.3–1.6× slower. VAD skips silence.
- **Load:** each desk sends at most one 6 s chunk per 6 s and usually far fewer because of silence gating. In theory one 2060 can serve about 5–8 desks at beam 2 and about 3–5 at beam 5. In practice, latency spikes when desks talk at the same time, because requests queue and the client queue holds only 2.
- **VRAM:** medium.en fp16 uses about 2–3 GB, int8_float16 about 1.5 GB, leaving headroom within 6 GB. Don't load a second model in the same process.
- **Measure before rollout:** check the `[timing] transcribe=` lines in `whisper-service.log` under N desks (IMPLEMENTATION Phase 3). Watch `nvidia-smi` for temperature and clocks, especially with the dead fan.
- **Single point of failure:** if many desks rely on one GPU server, one fault silences all of them. Keep each desk's local CPU Whisper installed for rollback.
