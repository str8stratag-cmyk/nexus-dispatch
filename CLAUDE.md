# Claude Code — Session Log

This file is auto-loaded by Claude Code at the start of every session in this
repo. It's a running, dated log of what Claude changed and why — read the
most recent entries first before starting work. This is separate from
`AGENTS.md` (fleet/ops context, device identity, startup checklist) — check
that file too, especially its "Session startup priorities" section.

**Convention:** newest entry first. Each entry: what was broken/asked, what
changed, why, and what's still open. Keep entries even after they're stale —
they're incident history, not a TODO list.

---

## 2026-09-28 (later still) — Added `FLEET-IDENTITY.md`: hostname-based identity for every box

**Ask (user):** after the DISP-2→DISP-3 mislabel above, build a shared file
so every box can learn its own identity from its hostname instead of a
hand-maintained banner in `AGENTS.md` (the thing that just went stale).

**Convention (from the user):** hostname `STRATAGCAP<N>` = fleet device
`DISP-<N>` (`STRATAGCAP3` = DISP-3, `STRATAGCAP2` = DISP-2, etc.).

**What changed:** new `FLEET-IDENTITY.md` at repo root — the convention, a
per-hostname lookup table, and instructions for a box (or an agent session
on it) to self-check via `$env:COMPUTERNAME` rather than trusting static
prose. `AGENTS.md`'s identity banner now points at it instead of restating
identity as fact.

**Honesty check on the table:** I only independently verified DISP-3 (this
box) in this session. DISP-2's IP (`192.168.6.52`) and DISP-3's documented
IP (`192.168.6.53`, contradicted by the `192.168.4.74` this box actually
has) are carried over from prior doc text, not re-checked. DISP-1, DISP-4,
DISP-5 have no IP on record at all — the table says so explicitly rather
than inventing values. The Mac doesn't fit the `STRATAGCAP<N>` pattern and
has no resolved identity method yet.

**Not pushed** — same rule as the identity-correction commit above. This
file only helps the other four boxes once it's actually shared with them;
flagging that to the user rather than assuming when to push.

---

## 2026-09-28 (later) — Corrected this box's identity in AGENTS.md (DISP-2 → DISP-3); unblocked pulls

**What was wrong:** `AGENTS.md` on this checkout asserted `THIS MACHINE IS
DISP-2`, with a fleet map, LAN IP, and startup instructions written for
DISP-2 (e.g. "the watchdog is intentionally not the startup path — use
refresh-services.bat"). A prior local, uncommitted edit had already flagged
this as wrong and reworked it to say DISP-3, but the release branch (PR #12,
`aa62860`) also touched `AGENTS.md`, so the uncommitted local edit and the
incoming release commit conflicted — this box's `git pull` would keep
failing/being skipped until that was resolved by hand.

**Verified independently before touching anything** (did not trust either
the old file text or the staged edit's claims at face value):
- Real hostname: `STRATAGCAP3`. Real LAN IP (`ipconfig`): `192.168.4.74` —
  on a different subnet than either `192.168.6.52` (DISP-2) or `192.168.6.53`
  (DISP-3) as previously documented. **Not re-verified against a physical
  network map — flagged as unverified in AGENTS.md, not asserted as fact.**
- `whisper-model.local` already has `WHISPER_MODEL=small.en` — matches the
  fleet standard from PR #12.
- `scripts\watchdog.ps1` **is genuinely running** (PID 10256, confirmed via
  `Get-CimInstance Win32_Process`) — contradicts the old AGENTS.md text
  claiming the watchdog isn't this box's startup path. The staged edit's
  claim of PID 4156 for this was wrong; corrected to the real PID/method.
- The user confirmed directly in chat: "THIS MACHINE IS DISP-3."

**What changed:** `git stash`'d the local `AGENTS.md` edit, fast-forward
pulled `origin/release` (now at `aa62860`, bringing in the `small.en`
fleet-standard content from PR #12), then re-applied an identity correction
by hand on top — DISP-2 → DISP-3 in the identity banner, "Local runtime
environment" section, Whisper endpoint note, fleet map, and the "Session
startup priorities" section (the watchdog-vs-refresh-services.bat guidance,
which was actively dangerous to follow as originally written on this box).
Kept everything release-side (small.en defaults, model-override mapping)
untouched.

**Not pushed.** Per this file's own standing rule ("Agents: never push to
`release` ... never merge to `main` without the owner's explicit approval in
the current conversation"), this is a local commit only. Other fleet boxes'
copies of `AGENTS.md` are unaffected.

**Still open / not verified:** the large historical narrative later in
`AGENTS.md` (turbo policy, unpushed-commit counts, `KIMI_RESUME.md`
"Session Startup Ritual", the 2026-09-21/22 incident log) reads as DISP-2's
history and was left as-is — not rewritten for DISP-3, just no longer
contradicted by the top-of-file identity banner. Worth a fuller pass if this
box's real operational history matters going forward. The `192.168.6.53`
fleet-map entry for this box is unverified, not corrected to `.4.74`, since
I don't know if `.53` is a static assignment this box should still claim
(e.g. via DHCP reservation) or just stale.

---

## 2026-09-28 — Whole fleet standardized on Whisper `small.en`

**Ask (user):** put every box on `small.en`; DISP-2 has been off turbo for
3-4 days, note that in the docs.

**Why:** on DISP-3 (i3-1005G1, 2 cores) medium.en took 11-13 s per 8 s
chunk, slower than real time, so the client's 2-deep queue dropped audio.
DISP-3 was switched by hand to small.en first (same beam 2 / thresholds).

**Changed:** default model `medium.en` → `small.en` in
`scripts/start-whisper.ps1` and `whisper/whisper_service.py`.
`start-whisper.ps1` also maps a retired model left in a box's untracked
`whisper-model.local` (`medium.en`, `medium`, `turbo`, `large-v3-turbo`) to
the fleet standard with a warning, so the fleet unifies through the normal
release pull. Any other explicit model still wins. AGENTS.md updated.

**Rollout:** each box's watchdog pulls `origin/release` within 6 h and picks
the model up at its next Whisper restart (4 h schedule). First start on a box
downloads small.en (~480 MB) from Hugging Face, so a box without internet
will fail to start Whisper until the model is copied in.

---

## 2026-09-22 (later still) — Pulled independent fleet fixes from "XQuiz"

While pushing the priority fix above, discovered 3 new commits already on
`origin/main` from another session (git author `XQuiz <xquiz@localhost>`,
pushed minutes earlier) that converged on the same CPU-contention symptoms
independently:

- `whisper/whisper_service.py` — a real, complementary bug: faster-whisper's
  segment generator runs inference lazily on first iteration, so the old
  `run_in_executor(transcribe_call)` returned immediately and the actual
  CPU-bound work happened outside any timeout boundary. A single hung 4s
  chunk could wedge the executor and `/health` with it, invisible to any
  watchdog timeout, until a manual restart (their incident: 4x on
  2026-09-21). Fix: `_transcribe_all()` consumes the generator inside the
  worker thread, wrapped in `asyncio.wait_for(..., timeout=300)`. Pulled and
  restarted Whisper on this box to load it — didn't touch this file myself
  today, no overlap with anything above.
- `scripts/watchdog-xquiz.ps1` (new file) — their own version of the exact
  timeout/debounce fix already in `scripts/watchdog.ps1` above (150s/3-strike
  vs. this box's 60s/2-strike), but turned out to be **hardcoded to a
  different, non-fleet environment**: path
  `C:\Users\XQuiz\...\kimi\tasks\...\dispatch-monitor`, and it manually
  prepends node/npm/git to PATH because they live inside a tool called
  "Kimi"'s bundled runtime rather than the system PATH. Not one of the
  documented DISP-N fleet boxes. Decision (user, 2026-09-22): leave it in
  the repo as-is — harmless, not referenced by this box's or any documented
  fleet box's startup path, and not portable here anyway given the hardcoded
  paths. `scripts/watchdog.ps1` stays canonical for this box: more complete
  (also has the log rotation and process-priority fixes XQuiz's version
  lacks), and already verified working end-to-end today.
- Small Busch-homophone additions to `extract-address.ts`/`routes.ts` — no
  conflict with this session's edits to the same files.

Take-away: the CPU-contention/restart-storm problem from this morning isn't
unique to this box — at least one other environment hit the same failure
mode around the same time and converged on a similar (if less complete) fix
independently. Reinforces that this is a systemic risk of running Whisper
alongside general desktop/other use, not a one-off.

---

## 2026-09-22 (later same day) — Transcription stalled again; baked in process-priority fix

**Ask:** "nothing is transcribing" — user was watching the capture UI
("Waiting for transcription...") with the LIVE feed running.

Same root cause as the morning incident, recurring: CPU back at 100%
(Chrome back up to 34-35 processes), Whisper `/health` took 17s, two
transcribes measured 25.7s and 58.6s for 4s clips. First tried closing
Chrome again — `CloseMainWindow()` barely worked this time (33→34 processes,
no CPU change), because most Chrome processes are background helpers with
no window to close gracefully. **Did not force-kill Chrome** — user was
actively watching that exact capture UI in a Chrome tab and I couldn't
identify which window was which from this automation context (no access to
enumerate window titles on the interactive desktop). Asked before touching
anything.

Used a safer lever instead: raised OS scheduling priority
(`Get-Process ... .PriorityClass`) — Whisper to `High`, the app to
`AboveNormal` — without touching any browser window. `/health` dropped from
17s to 6.3s immediately, transcription back to 0.1s/clip within ~15s.

**Baked into `scripts/watchdog.ps1`** (commit `b198210`) since process
priority doesn't survive a restart and manually reapplying it each time
isn't sustainable: `Set-ServicePriority` runs automatically at the end of
`Start-Whisper` (after it's confirmed ready) and after `Start-App`/
`Restart-App` (after polling for the port to bind). Verified end-to-end by
killing the live Whisper process and watching the watchdog's own debounce
detect-and-restart cycle re-apply `High` priority automatically — no manual
step needed.

**Also noted, not chased:** that restart hit a one-off
`Get-FileHash: command not found` in the pre-existing self-update block
(comparing the running script's hash to on-disk). Reproduced the identical
launch chain (`cmd /c "powershell ..."`) immediately after and it worked
fine — looks like a transient side effect of the 100%-CPU conditions at that
exact moment (module autoload under severe resource starvation), not a
reproducible code defect. Worth revisiting if it recurs, since this is the
same self-update mechanism that exists specifically to prevent a stale
watchdog running silently for hours (see the 2026-09-18 DISP-1 incident
referenced in `AGENTS.md`).

**User context, relevant going forward:** building dedicated physical
capture-box enclosures (radio + mic) so feeds are isolated per box. This
whole incident — and the morning one — is the software symptom of exactly
the problem that architecture solves: one box doing both live transcription
and everyday desktop use will keep hitting this under load. The
watchdog fixes here are a mitigation for *this* box, not a substitute for
that separation.

---

## 2026-09-22 — Outage since Friday + 10 code-review findings fixed

**Ask:** "system has been off since Friday, get it back running" + full repo
review.

**Root cause of the multi-day outage:** the Windows Startup `.vbs`
(`AppData\Roaming\...\Startup\dispatch-watchdog.vbs`) launched
`scripts/watchdog.ps1` with **no output redirection**, so `logs/watchdog.log`
went silent 2026-09-18 ~12:50 PM (Friday). No visibility into whether the
watchdog was supervising anything over the weekend. Fixed: the `.vbs` now
pipes watchdog output to `logs/watchdog.log` like every other service.

**Live crash-loop found during triage:** Whisper was up but watchdog kept
killing it every ~2 min. Measured cause: the box was pegged at 100% CPU
(4 cores; dozens of Chrome processes + Outlook + Whisper transcription all
contending), so a trivial `GET /health` took up to 48s — longer than the
watchdog's 30s timeout. Every "timeout" killed a working process mid-response,
forcing a full model reload, adding more load, guaranteeing the next check
missed too. Fixed in `scripts/watchdog.ps1`: timeout 30s→60s, and now
requires 2 consecutive misses (not 1) before restarting Whisper. Also closed
~47 stray Chrome processes to relieve the immediate pressure.

**Also found:** `logs/dispatch-monitor.log` had grown to **4.25 GB** —
opened in append mode by the watchdog, never rotated. A 2026-09-21 fix
(commit `e4fd9a7`) had stopped logging full GET response bodies but nothing
ever capped the file itself. Fixed: `Limit-LogSize` in `watchdog.ps1` archives
the app log to `.previous` once it exceeds 50MB, checked on every restart.
The old 4.25GB file is at `logs/dispatch-monitor.log.previous` — safe to
delete, not touched automatically.

**Process hygiene mistake (self-caught):** while cleaning up orphaned node
processes from earlier manual restarts, I killed the `trial/reconciler.mjs`
process too — it doesn't hold a network port, so the "no active connections"
check that correctly identified real orphans also matched it. Caught this
because its log (`trial/reconciler.log`) went stale; restarted it.

**Code review — 10 findings, fixed 9, flagged 1** (commit `cb72223`, pushed to
`origin/main`). Full rationale is in that commit message; short version:

- `server/whisper.ts` — `getWhisperModel()` cached a failed `/health` check
  forever (never retried). Reset the promise on failure, matching
  `getDatabase()`'s existing pattern in `server/mongodb.ts`.
- `shared/keywords.ts` — `"Road Mention"` was never in `VALID_SIGNAL_TYPES`,
  so the whole corroboration/cooldown/sweeper system for it in
  `server/routes.ts` was unreachable dead code. Added it.
- `server/routes.ts` — `getGeocodeQuery()`'s bare `.includes("tampa")` check
  silently broke geocoding for any road containing "tampa" as a substring
  (e.g. **Tampania Ave**). Anchored to city context (comma before it).
- `server/routes.ts` — quarantine restore never geocoded (items were
  rejected before geocoding ever ran in the normal intake path), so restored
  events had a permanently null map pin. Now geocodes/reverse-geocodes.
- `server/routes.ts` — quarantine restore + event status update had no
  `requireAuth`. Added, matching every other mutating endpoint. **Caveat:
  `ADMIN_SECRET` is not currently set in `.env` on this box, so `requireAuth`
  is a no-op everywhere right now** — this fix restores consistency but
  doesn't add real protection until `ADMIN_SECRET` is configured.
- `shared/keywords.ts` — the `"tow"` keyword's `(?![er])` lookahead did
  nothing to block "tower" (already blocked by the normal trailing word
  boundary) but did block "towed". Verified with `node -e` before and after.
  Replaced with an explicit allowed-suffix list (`s`/`ed`/`ing`).
- `client/src/hooks/use-dispatch-buffer.ts` — the transcript buffer was
  cleared *after* the `await onDispatch(...)` call, so a transcript arriving
  mid-flight mutated the still-shared array and could schedule a second,
  overlapping dispatch cycle. Clear before the await, in both the debounce
  callback and `flush()`.
- `client/src/lib/extract-address.ts` — missing the `"amd"`→`"and"`
  mishearing fix that `server/routes.ts` and `whisper_service.py` both
  already have (event 862, "AZEELE AMD TAMPANIA"). Added to `STOP_WORDS` and
  `CROSS_LINKERS`.
- `server/routes.ts` — `GET /api/quarantine`'s `reason` query param was cast
  to `string` at compile time only; Express's `qs` parser turns
  `?reason[$ne]=x` into an object at runtime, letting a caller inject Mongo
  query operators. Added a runtime `typeof` check.
- `trial/reconciler.mjs` — every server-side dedup hit (same source call
  re-seen within the 30-min window) was logged as `"Created DISP-3 event
  #undefined"` because it checked `res.ok` instead of `result.duplicate`.
  **Verified against the DB before touching this** — zero actual duplicate
  DISP-3 events existed, it was purely a misleading log message. Fixed to
  log dedup hits distinctly.

**Not fixed — flagged for a real decision:** the `/api/dispatch` dedup check
(`server/routes.ts`, the fuzzy address/transcript matching before insert) is
a classic check-then-act race. Two fleet boxes (all DISP-N devices share one
Atlas cluster) can both pass the dedup check for the same radio call within
milliseconds of each other and both insert + both alert Telegram. Can't be
closed with a DB unique index because the matching is fuzzy (Levenshtein
distance, radius match, not exact equality), and an in-process lock wouldn't
help since the race is cross-machine, not cross-request-on-one-process.

**A regression I introduced and caught before pushing:** adding
`requireAuth, writeLimiter` as extra middleware args to the two routes above
changed TypeScript's inferred type for `req.params.id` from `string` to
`string | string[]` (an Express+TS overload-resolution quirk with multiple
handler args). `npx tsc --noEmit` caught it; fixed with `String(req.params.id)`
at both call sites. Worth remembering if adding middleware to a route with
`:id`-style params elsewhere.

**Verification before calling it done:** `npx tsc --noEmit -p tsconfig.json`
clean; confirmed live Whisper transcription (0.1–0.5s/clip) and a real event
landing in Mongo; confirmed via a throwaway DB query that the reconciler
"bug" wasn't actually writing duplicates before fixing the log message.

**Not committed (left as-is, by user's choice or by design):**
- `scripts/start-whisper.ps1` — pre-existing local uncommitted change
  (`WHISPER_SAVE_AUDIO`/`WHISPER_SAVE_MAX`), explicitly commented
  "LOCAL ONLY (do not commit)" in the file itself.
- `trial/dump-calls.mjs`, `trial/mongo-latency.mjs`, `trial/purge-old-events.mjs`
  — untracked, presumably user WIP, untouched.
- `whisper/debug-audio/` — local debug audio retention dir, untracked.
- `logs/dispatch-monitor.log.previous` (4.25GB) — archived, not deleted.
