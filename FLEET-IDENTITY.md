# Fleet Identity — how a device learns who it is

**Purpose:** this file exists because a hardcoded `THIS MACHINE IS DISP-2`
banner in `AGENTS.md` went stale on this checkout and nobody caught it until
2026-09-28 (see `CLAUDE.md`, "Corrected this box's identity"). Copied,
uncommitted, or partially-merged docs drift. A device's **hostname doesn't
drift** — so identity should be derived from it, not asserted as static text
that has to be kept in sync by hand across five machines.

This file is shared/tracked (pushed like any other doc), so every box's
clone has the same lookup table. `AGENTS.md`'s identity banner should say
"derive your identity from this file," not restate it — see the note at the
bottom.

## The convention

> **hostname `STRATAGCAP<N>` = fleet device `DISP-<N>`**

To find your own identity, on any box:

```powershell
$env:COMPUTERNAME   # or: hostname
```

Match the number after `STRATAGCAP` to the table below. If your hostname
doesn't fit the pattern, **stop and ask the user** rather than guessing —
don't assume you're DISP-anything.

## Known devices

| Hostname | Fleet name | Last-known LAN IP | Verified | Notes |
|---|---|---|---|---|
| `STRATAGCAP2` | DISP-2 | `192.168.6.52` | Not re-verified since original 2026-09-02 note (that note was later found unreliable on the DISP-3 box — treat with caution until re-checked with `ipconfig` on that box) | Was fleet's Whisper v3 Turbo tester until ~2026-09-25; off turbo since, now `small.en` |
| `STRATAGCAP3` | DISP-3 | `192.168.6.53` documented, but **`192.168.4.74` observed via `ipconfig` on 2026-09-28** (different subnet) | Confirmed by user 2026-09-28; IP mismatch unresolved | Watchdog-managed (4h Whisper restart, 6h `git pull` on `origin/release`), runs `trial/` reconciler every 3 min, `small.en` |
| `STRATAGCAP1` | DISP-1 | Unknown — not documented in `AGENTS.md`/`CLAUDE.md` | Not verified | Referenced in incident history (16h hang, 2026-09-18 self-update issue); no IP on record |
| `STRATAGCAP4` | DISP-4 | Unknown — not documented | Not verified | Referenced only via "DISP-4 fleet review" (2026-09-12 keyword lesson) |
| `STRATAGCAP5` | DISP-5 | Unknown — not documented | Not verified | Referenced in dispatch events and an address-parsing incident |
| *(Mac)* | Mac | N/A | N/A | No `STRATAGCAP<N>` hostname — doesn't fit this convention. Only device confirmed reachable via Remote Desktop Commander as of the 2026-09-28 session notes; identity method for it is unresolved |

**Read this table as "what's on record," not as verified fact for boxes
other than the one you're running on.** Every entry above except DISP-3's
hostname-confirmation was inherited from prior doc text, not re-checked by a
live session. If you're a box other than DISP-3 reading this, verify your
own IP with `ipconfig` before trusting the table, and correct your row if
it's wrong — then flag the correction in `CLAUDE.md` the way the DISP-3 fix
was flagged, so the next reader knows what changed and why.

## For `AGENTS.md` maintainers

Don't hardcode `THIS MACHINE IS DISP-N` as plain prose again. Instead:

1. Run `$env:COMPUTERNAME`.
2. Look it up here.
3. If it matches a known row, state identity with a pointer back to this
   file (e.g. "per `FLEET-IDENTITY.md`, hostname `STRATAGCAP3` → DISP-3"),
   so a future reader can re-derive it instead of trusting stale prose.
4. If it doesn't match, don't guess — ask the user, and add a new row here
   once confirmed (with today's date and how it was confirmed).
