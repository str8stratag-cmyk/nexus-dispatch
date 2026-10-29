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

## 2026-10-29 — Live-location check-in + continuous membership gate

**Ask (Zach):** check-in is sharing Telegram Live Location. Continuous gate:
approve join requests, 10 min to share or be removed (ban+unban), warn once
then remove if a live share stops/expires/goes stale. Exempt list, timings
configurable, flag off by default, single poller desk. Nearest-driver DM
routing and private `/start` handling were dropped from scope. Calls keep
posting to the group as before.

**What changed (branch `cursor/live-location-gate-8ea7`, PR, not merged):**
- `server/driver-live-gate-helpers.ts` + `server/driver-live-gate.ts`: state
  machine and Mongo `driverLiveGate`. Wired through `handleTelegramUpdate`
  and the existing Accept poller / webhook receiver only.
- Flag `DRIVER_LIVE_GATE` (default off). Not the daily `DRIVER_LOCATION_GATE`.
- Tests: `trial/test-driver-live-gate.ts`. Env notes in `README.md` and
  `.env.example`.

**Rollout:** Disp-1 only (the `TELEGRAM_ACCEPT_POLL=1` desk), after review.
Bot needs invite-via-link + ban rights. Group invite must be a join-request
link. Restart that app after turning the flag on.

**Still open:** owner review. Do not promote to `release` from this branch.

## 2026-10-27 — Accepted / resolved calls come off the board

**Ask (Zach):** once a call is accepted or resolved it should come off the
board — handled calls were cluttering the map.

**What changed (PR `fix/hide-handled-calls` → `main`):**
- `pages/dispatch.tsx`: new `showHandled` state (default off). Map markers
  skip `accepted` / `resolved` events unless it's on. If the selected call
  becomes handled (detail-panel Accept/Resolve, card Accept, or a Telegram
  accept arriving over SSE), the selection clears so the detail panel closes.
- `components/event-log.tsx`: accepted / resolved sections hidden unless
  `showHandled`; a "Show handled (N)" pill in the filter row toggles it (same
  switch drives the map). Stats, CSV/JSON export unchanged (export still
  includes everything).

**Verified:** Playwright vs a stateful mock API: Accept from detail → pin
5→4, card gone, panel closed; Resolve → 4→3; card quick-Accept → 3→2;
"Show handled" brings all back (7 pins), off again → 3.

**Not changed:** server statuses / Telegram. "Unaccepted" filter pill is now
mostly redundant with the default view; left in place.

---

## 2026-10-26 (later) — Manual / Review / Setup rendered halfway down; Roads on by default

**What was broken (on release after #90/#91):** clicking Manual or Review in
the rail showed the page starting ~halfway down the screen (y≈500 of 900).
Radix keeps the inactive Live `TabsContent` in the DOM with the `hidden`
attribute, but its `flex flex-1` classes override `hidden`, so the empty Live
panel took a flex-1 share of the height and pushed the active page down.
Pre-existing (same classes before #90), just more visible now.

**What changed (PR `fix/tab-offset-roads-default` → `main`):**
- `pages/dispatch.tsx`: `data-[state=inactive]:hidden` on the Live
  `TabsContent`. Display-only — AudioPanel stays mounted exactly as before.
- `components/dispatch-map.tsx`: Esri Roads overlay on by default, Labels
  overlay off by default (Zach: "include roads, don't care about the label";
  Roads already carries street names). Both still toggle in the layer box.

**Verified:** built + Playwright against a mock API at 1600 and 1100 wide:
Manual/Review/Setup now start right under the header (y 92/76/92), Live map
back to full height after switching, overlays Roads=on Labels=off.

**Still open:** promote to `release` after Zach reviews. At ~1100px wide the
#90 layout leaves the map ~330px (fixed 360 + 340 side columns, no tablet
drawer) — separate follow-up if desks run narrow windows.

---

## 2026-10-05 — Telegram Accept-button long-poll (Disp-1 only)

**What was broken:** STGAPPBOT sends Accept inline buttons on DISPATCH RELAY
alerts, and `/api/telegram/webhook` + `handleTelegramUpdate` already exist, but
no desk had a public HTTPS URL and nothing polled `getUpdates`, so taps went
nowhere.

**What changed (PR `fix/telegram-accept-poll`, do not merge/promote yet):**
- Env-gated long-poll: `TELEGRAM_ACCEPT_POLL=1` on exactly one desk (preferred
  Disp-1). Default off so other desks never compete for the bot.
- On that desk only: delete leftover webhook once at setup, then poll
  `callback_query`. Shared Mongo offset + atomic `claimEventAccepted`.
- Persist `acceptedBy` on the event; board/CSV show it. Webhook path still for
  future AWS / app.StrataG.app (`TELEGRAM_WEBHOOK_URL`).
- Deliberately not reusing PR #18's "delete webhook whenever no URL" design.

**Still open:** merge + set env on Disp-1 after review; webhook cutover later.

## 2026-09-29 (later) — Reconciled with PR #13 (DISP-4's identity fix, merged); adopted `device-identity.local`

**What happened:** DISP-4 was independently building the same fix (see
entry below) and pushed `fix/agents-md-identity-v2`. I found this by
fetching before deciding whether to push my own local commit, compared the
two rather than pushing a conflicting second version, and asked the user
how to reconcile. DISP-4's session (via the user, pasting their reasoning)
recommended standardizing on their `device-identity.local` filename (plain
`DEVICE=DISP-N`, matching the existing `whisper-model.local`/
`watchdog.local` convention) since it was already written into their
branch's `AGENTS.md` prose — and by the time I checked, PR #13 had already
been merged to `origin/main`, making that the live convention regardless.

**Verified independently before acting on it** (that reasoning arrived as
pasted text from another session, so treated as a claim, not a fact):
`gh pr list` confirmed PR #13 really is merged; `git show origin/main:AGENTS.md`
confirmed it documents `device-identity.local`, not my `LOCAL-IDENTITY.md`,
and — beyond what I'd caught — forbids ANY per-device notes table in
`AGENTS.md`, not just a "this machine is X" banner (my commit had added a
fleet-map table with per-device rows, which itself violated their
already-merged policy). Their "Session startup priorities" fix also
independently covers the same watchdog-vs-refresh-services.bat issue I'd
fixed, equivalently.

**What changed:**
- `git rebase origin/main`: took `origin/main`'s `AGENTS.md` wholesale
  (`git checkout --ours` during the rebase) rather than resolve conflicts
  by hand — it was a strict superset of what my version had, done more
  correctly. `FLEET-IDENTITY.md`, `CLAUDE.md`, `.gitignore`, and the
  `whisper/text_fixes.py` blocklist work auto-merged cleanly (PR #13 never
  touched those files).
- Deleted `LOCAL-IDENTITY.md`; replaced with `device-identity.local`
  (`DEVICE=DISP-3` plus the same facts, in the project's existing
  `KEY=value` `.local`-file shape) — already covered by the pre-existing
  `*.local` gitignore rule, so removed the now-redundant explicit
  `LOCAL-IDENTITY.md` gitignore entry too.
- Updated `FLEET-IDENTITY.md`'s remaining references from
  `LOCAL-IDENTITY.md` to `device-identity.local` for consistency with
  `AGENTS.md`. Left the entry below as-is (accurate history of what I
  actually did at the time) rather than rewriting it to match this outcome.

**Still open:** none of this was pushed by me — it was already merged via
PR #13 before I got here; my local branch is now rebased on top of it with
only the blocklist/beam-size work as genuinely new commits.

---

## 2026-09-29 — Split device identity out of the repo entirely (`LOCAL-IDENTITY.md`)

**Ask (user):** remove device identity from repo `.md` files — the repo's
docs should track the fleet, not one device's identity, since that's what
kept causing confusion across the fleet. Each device should have its own
separate, local file instead.

**Why this matters, concretely:** the `FLEET-IDENTITY.md` fix from
yesterday still had the same class of bug it was meant to solve — its first
version said "on THIS checkout, hostname is STRATAGCAP3 → DISP-3" directly
in the tracked file. Since that file is the *same content on every box's
clone*, pushing it would have told DISP-2, DISP-4, DISP-5, and the Mac that
*they* were DISP-3 too, the next time each one read it. Caught same-day,
before it caused a repeat of the 2026-09-28 DISP-2/DISP-3 incident on a
different box.

**What changed:**
- New `LOCAL-IDENTITY.md` at repo root, **gitignored** (added to
  `.gitignore` with an explanatory comment) — states "THIS MACHINE IS
  DISP-3" as a flat fact, plus this box's specific hostname/IP/role. Exists
  only on this box's disk; never committed, never pushed.
- `AGENTS.md`'s IDENTITY banner rewritten: no longer names a device at all.
  Instead it tells a reader to check `LOCAL-IDENTITY.md`, and if that file
  is missing, how to derive and create it (hostname → `FLEET-IDENTITY.md`
  table → confirm with user → write `LOCAL-IDENTITY.md`). Explicitly says:
  never write "this machine is DISP-N" into a tracked file again.
- `AGENTS.md`'s "Local runtime environment" section and fleet map: removed
  "(this machine)" markers and "THIS machine's IP" language; reframed as
  fleet-wide facts only, with a pointer to `LOCAL-IDENTITY.md` for anything
  device-specific.
- `AGENTS.md`'s "Session startup priorities" #1 (watchdog vs
  refresh-services.bat): removed the "this box is DISP-3, watchdog verified
  running" claim I wrote in there yesterday — replaced with an instruction
  to check directly every session (`Get-CimInstance` for a live
  `watchdog.ps1`) rather than trust prose, and to record the answer in
  `LOCAL-IDENTITY.md` once confirmed.
- `FLEET-IDENTITY.md`: reworded to explicitly forbid stating "this machine
  is X" in itself, names `LOCAL-IDENTITY.md` as the per-device counterpart,
  and documents its own near-miss (see above) so the reasoning isn't lost.

**Not pushed.** Also relevant right now: the user mentioned DISP-4 is
concurrently making its own repo `.md` changes this session — so even
once these are ready, I'll fetch `origin/release` first and check for
conflicts before pushing, rather than assume nothing else has landed.

**Update, same session — reconciled with DISP-4's concurrent fix:** fetched
and found DISP-4 had already pushed `fix/agents-md-identity-v2`, doing the
same restructure independently. Compared rather than pushing a conflicting
second version. DISP-4's caught two real, repo-wide bugs I'd missed:
- `AGENTS.md` had a hardcoded `Local path: C:\Users\str8s\dispatch-monitor`
  line — same identity-leak pattern as the device banner, just for a path
  instead of a device name.
- `AGENTS.md` said "do NOT push this AGENTS.md (machine-specific)" while the
  file was obviously being pushed every release anyway — a real
  contradiction, and arguably part of how the original bug got out: a
  policy telling people not to push a file that kept getting pushed with a
  hardcoded identity baked in.

Per the user's direction, kept my `LOCAL-IDENTITY.md` (Markdown) as the
per-device file rather than switching to DISP-4's `device-identity.local`
(plain `KEY=value`, fits the existing `*.local` gitignore pattern) — the
user was explicit that the local file should be **Markdown**. Folded
DISP-4's two fixes into my version by hand (credited to DISP-4 in the
prose), plus their DISP-4 fleet-map row (`small.en`,
`WHISPER_BEAM_SIZE=3`/`BEST_OF=3`, `VITE_SILENCE_RMS=0.03`) and this box's
current beam/blocklist state.

**Known unresolved naming mismatch:** DISP-4's own box likely has a file
named `device-identity.local`, not `LOCAL-IDENTITY.md` — the two sessions
converged on different filenames for the same concept before comparing
notes. `AGENTS.md` now only documents `LOCAL-IDENTITY.md`. Someone should
tell DISP-4's session to rename/align, or the fleet ends up with two
inconsistent per-device filename conventions — didn't do this myself since
I have no access to DISP-4's box.

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

**Update, same session:** user confirmed the Mac is `DISP-7` — breaks the
numeric `STRATAGCAP<N>` sequence, so it's recorded as a named exception in
`FLEET-IDENTITY.md` rather than forcing it into the pattern. Its hostname
is still unknown; not guessed, left for whoever's on that box to fill in.

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
