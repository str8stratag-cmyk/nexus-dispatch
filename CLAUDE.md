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
