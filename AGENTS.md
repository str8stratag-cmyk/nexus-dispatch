# Dispatch Monitor — Project Context

> **Also read `CLAUDE.md`** — a separate, Claude-Code-auto-loaded running log
> of session-by-session changes (what broke, what changed, why). This file
> (`AGENTS.md`) stays focused on fleet/device/ops context; `CLAUDE.md` is the
> detailed incident-by-incident history.

> **IDENTITY: see `FLEET-IDENTITY.md`.** Convention: hostname
> `STRATAGCAP<N>` = fleet device `DISP-<N>`. On THIS checkout, hostname is
> `STRATAGCAP3` → **DISP-3** (confirmed by the user 2026-09-28; repo at
> `C:\Users\NoName\dispatch-monitor`). Don't just trust this line if it's
> stale — re-run `$env:COMPUTERNAME` and check `FLEET-IDENTITY.md` yourself;
> that file, not this banner, is the source of truth, since this exact
> banner went stale and wrong once already (see `CLAUDE.md` 2026-09-28).
> **Note:** this box's actual LAN IP was observed as `192.168.4.74` on
> 2026-09-28, on a different subnet than the `192.168.6.53` this file
> previously documented for DISP-3 — treat `.53` as unverified until checked
> again with `ipconfig`. Work self-contained: do NOT probe or depend on other
> DISP devices for config or shared services — their DBs/services are
> localhost-bound and irrelevant here. When something is missing (e.g.
> MongoDB URI), the fix comes from the user or this box, not from poking
> other fleet boxes.

## Project overview
A full-stack dispatch monitoring dashboard. It captures live audio, transcribes speech, detects emergency keywords, and creates dispatch events stored in MongoDB Atlas.

- Repo: `str8stratag-cmyk/dispatch-monitor`
- Local path: `C:\Users\str8s\dispatch-monitor`
- Branch: `main`
- Deployment: **Vercel retired** (switched to MongoDB Atlas + locally-run apps on the fleet, at agent advice) — see master `AGENTS.md`

## Local runtime environment (this device)

This Windows machine is **DISP-3** (identity confirmed by the user 2026-09-28;
this file previously — and incorrectly — described it as DISP-2). It runs
Whisper watchdog-managed, per the fleet map below.

> **FLEET WHISPER MODEL = `small.en` ON EVERY BOX (user decision 2026-09-28).**
> No box runs `medium.en` or `turbo` anymore. `scripts/start-whisper.ps1` and
> `whisper/whisper_service.py` default to `small.en`, and `start-whisper.ps1`
> overrides a leftover `medium.en`/`turbo` in `whisper-model.local` to the
> fleet standard (with a warning). The turbo/medium.en notes below are history.

**MongoDB (RESOLVED 2026-09-04):** the app is MongoDB-only (migrated from Supabase).
Shared fleet cluster: **MongoDB Atlas** (`mongodb+srv`, host `nexus-disp.dndtjvg.
mongodb.net`, db `str8stratag_db_user`) — the SAME database all DISP devices write
to (that's how the reconciler dedups across devices). Credentials live ONLY in each
repo's `.env` (gitignored) — NEVER commit them, never write them into this file.
If `.env` ever loses them, ask the user; do not hunt for MongoDB on other devices.

- **Whisper endpoint (LAN):** THIS machine serves Whisper on `0.0.0.0:8178`.
  Fleet map below lists `192.168.6.53` for DISP-3, but `ipconfig` on
  2026-09-28 showed this box's actual address as `192.168.4.74` (different
  subnet) — re-verify before pointing any other device at this box over LAN.

**Fleet map (confirmed 2026-09-03, identity of this machine corrected 2026-09-28):**
| Device | IP | Role |
|--------|----|------|
| DISP-2 | 192.168.6.52 | Whisper small.en (off turbo since ~2026-09-25), dispatch :5000 (nexus :5001 retired from runtime 2026-09-18) |
| **DISP-3 (this machine)** | 192.168.6.53 (unverified — see note above; observed `.4.74` 2026-09-28) | Whisper small.en (was medium.en until 2026-09-28), watchdog-managed (4h restart, 6h git pull), runs `trial/` reconciler every 3 min |

Status reports mentioning "watchdog-managed, reconciler" now correctly
describe THIS machine. The Azure Maps account
(Client ID 65434727-…) is shared across the fleet; this machine uses the same key
(stored in `.env`, gitignored).

## Release branch: what the fleet runs (2026-09-25, READ FIRST)

The fleet watchdog deploys **only `origin/release`**, not `main`.

- Merging or pushing to `main` does **not** deploy anything. Code reaches the
  boxes only when the owner promotes it: `scripts\promote-release.ps1`
  (shows the pending commits and asks for confirmation), or
  `git push origin origin/main:refs/heads/release`.
- **Agents (Claude, Grok, Codex, Kimi, any bot): never push to `release`,
  never run promote-release.ps1, and never merge to `main` without the
  owner's explicit approval in the current conversation.** Open a PR and stop.
- Per-box override (rarely needed): `DEPLOY_BRANCH=<branch>` in the untracked
  `watchdog.local`.
- nexus-dispatch is dormant on the fleet, so its pull still tracks `main`.
  Switch it to the release branch before re-enabling it.
- Why: on 2026-09-24 a bot opened and merged PR #6 in 27 seconds with no
  review, and the 4h watchdog pull put it on every box automatically.

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
- **Policy (user decision 2026-09-03, SUPERSEDED 2026-09-28):** turbo stayed on
  DISP-2 as the tester. DISP-2 came off turbo ~2026-09-25, and on 2026-09-28
  the user standardized the whole fleet on `small.en`.
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
  starts/stops Whisper + Dispatch; Nexus :5001 was retired from this box's runtime
  2026-09-18 per user decision — the script no longer starts it, though its kill
  sweep still frees :5001). After a reboot, services
  come up on login — verify with the health checks if anything seems down.
- Never travels via git (gitignored): `whisper-model.local`, `.env` (Azure Maps
  key), `KIMI_RESUME.md`, logs, `test-audio.wav`.
- After ANY future `git pull`, run the post-pull checklist below — upstream
  removed the `whisper-model.local` block once already.
- **Model:** `small.en`, the fleet standard (2026-09-28). `whisper-model.local`
  may still hold per-box decode knobs (beam size, thresholds); a retired model
  name in it (`medium.en`/`turbo`) is overridden to `small.en` at start. Note:
  `nexus-dispatch/start-whisper-disp2.bat` (distil-large-v3, port 8179) came from the
  fleet's shared repo — it is NOT this box's config and should not be run here.
- **Whisper bind:** `0.0.0.0:8178` in BOTH `scripts/start-whisper.ps1` and
  `scripts/start-whisper-detached.ps1` — keep them consistent or LAN access breaks.
- **Firewall:** inbound TCP 8178 must be allowed (rule name `Whisper v3 Turbo (8178)`).
  Adding it requires an elevated shell:
  `netsh advfirewall firewall add rule name="Whisper v3 Turbo (8178)" dir=in action=allow protocol=TCP localport=8178`
- **Services:** Whisper `:8178`, Dispatch Monitor `:5000`. Nexus Dispatch
  (`:5001`) was retired from this box's runtime 2026-09-18 per user decision —
  the nexus-dispatch repo stays as a clone/edit base for future apps, not run
  in production here.
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
  `whisper-model.local` → runs the fleet standard `small.en`.
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
     (upstream removed it once already; it still carries per-box decode knobs).
  3. Restart services (`scripts/refresh-services.bat`) and confirm
     `/health` reports `"model":"small.en"`.
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

Every time this box is fired up, work in this order:

1. **Fire up / check the full stack.** CORRECTED 2026-09-28 (identity fix):
   this text below was written for DISP-2, where the watchdog was NOT the
   startup path. This box is actually DISP-3, and `scripts\watchdog.ps1`
   **is already running** here (verified via process list, 2026-09-28) — it
   IS the supervisor: manages Whisper restarts (4h) and `git pull` (6h) on
   `origin/release`. Do NOT run `scripts\refresh-services.bat` or any Desktop
   refresh shortcut while the watchdog is live — its kill sweep races the
   watchdog's restarts and wedges the apps, per the warning below. If Whisper
   or the app is down, prefer letting the watchdog recover it, or start it
   directly (`scripts\start-whisper.ps1` / `npm run dev`) rather than the
   refresh bat. Verify 8178/health and :5000/api/events are responding
   before doing anything else. Full ritual (calls review, Whisper tuning
   order): see `KIMI_RESUME.md` → "Session Startup Ritual" (written for
   DISP-2; treat with the same caution as everything else below). NEVER
   start a second watchdog (e.g. `start-watchdog.bat`) while one is running
   — two watchdogs race restarts and wedge the apps. App output goes to
   `dispatch-monitor\logs\dispatch-monitor.log` and
   `nexus-dispatch\logs\nexus-dispatch.log` — if an app won't bind its port,
   check those logs first. A healthy Whisper instance shows TWO python.exe
   processes (the `.venv-whisper` launcher and the real interpreter it
   spawns) — killing the launcher kills the service.

### NEXT FIRE-UP — OFFICE RETURN (2026-09-21 AM)

This box spent the weekend at the user's home (no radio feed — silence
was expected). Back in the office, THE task is the live radio test:

1. Scanner on. Ear-check that the capture feed hears SCANNER audio, not
   room noise — at home it only heard room chatter (weekend at home).
2. Watch `APPS\capture-disp3.log` for `INGEST 200` lines and Mongo for
   `source=DISP-3` events. This device pushed ~nothing for a week+
   before the weekend; this test proves the JOUNIVO path end to end.
3. Watch `CAPTURE\drops\` — if it floods, beam 2 is still too slow for
   the i3. beam_size=2 is a LOCAL UNCOMMITTED edit in
   `whisper\whisper_service.py` — decide commit/push only after this test.
4. Clean initial_prompt (commit 3d746b8) is live — check transcripts for
   fabrications on garble; flip CLEAN_PROMPT to None if it fabricates.
5. Feed must target "Microphone (JOUNIVO JV610)". "Microphone (USB
   Composite Device)" is a DIFFERENT mic — do not point the feed at it.

State at shutdown (2026-09-21 ~06:30): watchdog single instance (nexus
block removed, FEED=DISP-3), capture on JOUNIVO, whisper :8178 and app
:5000 both on new code and 200. Old quarantine echo junk (~200 items)
not yet purged — purge on request.

2. **Review calls and tune Whisper** — listen to recent transcriptions/dispatch
   events, find recurring mis-transcriptions, and add homophone corrections to
   `HOMOPHONE_FIXES` in `whisper/whisper_service.py` (restarting Whisper after
   edits; the watchdog will do it if you kill the 8178 process).
3. **Then any other tasks.**

## Recent changes (2026-09-22) — Watchdog restart storm + 10 review findings; committed cb72223, pushed

See `CLAUDE.md` for the full write-up (root causes, verification steps,
regression caught before push). Short version:

- **Root cause of the "off since Friday" report:** the Startup `.vbs`
  (`dispatch-watchdog.vbs`) launched `scripts/watchdog.ps1` with no output
  redirection — `logs/watchdog.log` went silent 2026-09-18 ~12:50 PM, so
  nobody could see whether the watchdog was supervising anything over the
  weekend. Fixed: `.vbs` now redirects to `logs/watchdog.log`.
- **Live crash-loop:** watchdog's 30s `/health` timeout was shorter than
  Whisper's actual response time under CPU contention (measured 48s — box
  had ~47 stray Chrome processes pegging all 4 cores), so it killed a
  working process every cycle, forcing a model reload that made the next
  check miss too. Fixed: timeout 60s, requires 2 consecutive misses before
  restarting.
- `logs/dispatch-monitor.log` had grown to 4.25GB (append-only, never
  rotated). Added `Limit-LogSize` to `watchdog.ps1`: archives to `.previous`
  past 50MB on every restart.
- Code review fixed 9 correctness/security findings across
  `server/whisper.ts`, `shared/keywords.ts`, `server/routes.ts`,
  `client/src/hooks/use-dispatch-buffer.ts`,
  `client/src/lib/extract-address.ts`, `trial/reconciler.mjs`. Flagged but
  NOT fixed: `/api/dispatch`'s dedup check is a check-then-act race across
  fleet boxes sharing one Atlas cluster — needs a real design decision
  (fuzzy matching can't use a unique index).
- `ADMIN_SECRET` is still unset in `.env` on this box — the `requireAuth`
  additions from this session are no-ops until it's configured.

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
