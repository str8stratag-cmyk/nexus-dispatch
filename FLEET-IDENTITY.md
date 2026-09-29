# Fleet Identity — how a device learns who it is

**Purpose:** this file exists because a hardcoded `THIS MACHINE IS DISP-2`
banner in `AGENTS.md` went stale on one box's checkout and nobody caught it
until 2026-09-28 (see `CLAUDE.md`, "Corrected this box's identity"). Copied,
uncommitted, or partially-merged docs drift. A device's **hostname doesn't
drift** — so identity should be derived from it, not asserted as static text
that has to be kept in sync by hand across five machines.

This file is shared/tracked (pushed like any other doc, same content on
every box's clone), so it can hold the fleet-wide lookup table but **must
never** state which row is "this machine" — that fact is different on every
clone and belongs in each box's own **`device-identity.local`** (gitignored,
one per box, never committed — see `AGENTS.md`'s IDENTITY note). 2026-09-29:
restructured for exactly this reason, after this file's own first version
briefly said "on THIS checkout, hostname is STRATAGCAP3" — a mistake in
the same direction as the original DISP-2 bug, just caught same-day instead
of days later.

## The convention

> **hostname `STRATAGCAP<N>` = fleet device `DISP-<N>`**

This holds for the Windows boxes. The Mac is the one confirmed exception —
it's `DISP-7`, not part of the numeric `STRATAGCAP<N>` sequence — so don't
assume every `DISP-N` name maps back to a `STRATAGCAPN` hostname; check this
table, and if a device isn't in it, ask rather than guessing.

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
| Unknown — hostname not on record | **DISP-7** | N/A | Fleet name confirmed by user 2026-09-28; hostname not yet given | The Mac. Doesn't fit the `STRATAGCAP<N>` → `DISP-<N>` numeric pattern (7 breaks the 1–5 sequence seen elsewhere), so don't assume its hostname — get it directly (`hostname` on the Mac) and record it here rather than guessing. Only device confirmed reachable via Remote Desktop Commander as of the 2026-09-28 session notes |

**Read this table as "what's on record," not as verified fact for boxes
other than the one you're running on.** Every entry above except DISP-3's
hostname-confirmation was inherited from prior doc text, not re-checked by a
live session. If you're a box other than DISP-3 reading this, verify your
own IP with `ipconfig` before trusting the table, and correct your row if
it's wrong — then flag the correction in `CLAUDE.md` the way the DISP-3 fix
was flagged, so the next reader knows what changed and why.

## Establishing identity on a box (do this, not prose in a tracked file)

1. Run `$env:COMPUTERNAME`.
2. Look it up in the table above.
3. If it matches a known row, and/or the user confirms it in chat, write
   the result into that box's **`device-identity.local`** (gitignored,
   repo root, `DEVICE=DISP-N`) — never into `AGENTS.md`, this file, or
   anything else that's tracked. See `AGENTS.md`'s IDENTITY note for format.
4. If it doesn't match, don't guess — ask the user, then both create that
   box's `device-identity.local` AND add a new row to the table above
   (dated, with how it was confirmed) so the next box benefits.
5. Never write "this machine is DISP-N" into `AGENTS.md`, this file, or any
   other tracked file — that's the exact mistake this restructure fixes.
   Fleet-wide facts (the table, the convention) are tracked; which row
   applies to "here" is not.
