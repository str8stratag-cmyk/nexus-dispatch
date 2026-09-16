# Fleet Post-Pull Runbook — 2026-09-16 update

Read this after `git pull` brings in the squash-merged fleet update (source
branches: `fleet/geocode-and-quarantine` in this repo, `fleet/azure-geocoding`
in nexus-dispatch). Watchdog-managed boxes get it automatically on the 6h
pull + 4h restart cycle; anyone can apply it manually with the steps below.

## What changed (behavior you will notice)

- **Road Mention gate:** a bare road name with no crash keyword now needs
  dispatch context in the same transmission (unit responding, 10-codes, etc.)
  OR the same road active in an event within 45 min. Otherwise it lands in the
  new **Quarantine** tab instead of auto-dispatching. Expect FEWER Road
  Mention dispatches — that is the fix working, not a breakage. Road mentions
  were ~48% of all events; most were "Florida tag" phonetics, not calls.
- **Quarantine tab (UI):** rejected auto-dispatches (production audio, TV
  audio, signal counting, keyword spam, unresolved address, context-free road
  mentions) are now kept for review and can be restored as manual events —
  previously they were dropped silently.
- **"Florida Ave" geocoding fixed:** the geocoder no longer strips the
  "Tampa, FL" context from addresses containing the road name Florida
  ("Florida Ave", "34th, Florida Ave", "Florida and Nebraska"). These were
  ~57% of all coord-less events; they now pin correctly on the map.
- **whisperModel tagging:** every event is stamped with the Whisper model that
  produced it, for fleet accuracy comparison. Run
  `node scripts/accuracy-by-source.mjs 24` for per-source stats.
- **Nexus Dispatch:** Azure Maps is now the primary geocoder (Geoapify and
  Nominatim remain fallbacks), and `/api/dispatch` pins coordinates at
  creation — manual entries (sent without coordinates) and auto events from
  clients that don't geocode no longer land coord-less.

No database migration is needed: MongoDB documents are schemaless here; the
new fields (`whisperModel`) and the `quarantinedDispatches` collection appear
automatically.

## Do this on every box (Git Bash)

```bash
# 1. Pull both repos (watchdog boxes: automatic on the 6h cycle)
cd ~/dispatch-monitor && git pull
cd ~/nexus-dispatch && git pull

# 2. Reinstall deps + type-check.
#    package.json did not change, but run npm install anyway — it is cheap
#    and prevents the missing-dependency crash on post-pull restarts.
cd ~/dispatch-monitor && npm install && npm run check
cd ~/nexus-dispatch && npm install && npm run check

# 3. One-time per box: make sure Nexus has the Azure key.
#    Copy AZURE_MAPS_KEY from dispatch-monitor/.env into nexus-dispatch/.env
#    (same fleet-wide key). Without it Nexus still runs, but geocoding falls
#    back to Geoapify/Nominatim instead of Azure.

# 4. Restart your services (watchdog boxes: automatic on the 4h cycle;
#    otherwise use your usual start script), then verify:

curl -s -m 30 http://127.0.0.1:8178/health   # your whisper port; note the model
curl -s -G http://127.0.0.1:5000/api/geocode --data-urlencode "q=Florida Ave"
curl -s -G http://127.0.0.1:5001/api/geocode --data-urlencode "q=Florida Ave"
#    ^ both must return JSON with provider "azure-maps" and Tampa
#      coordinates. Before this update they returned 404 / "outside service area".
```

Then open the dispatch UI and confirm: a **Quarantine** tab exists (left
navigation), and newly created events carry a `whisperModel` field
(inspect via the API: `curl -s "http://127.0.0.1:5000/api/events?limit=3"`).

## If something looks wrong

- `npm run check` fails after the pull → `npm install` was skipped or
  interrupted; run it and retry.
- "Florida Ave" geocode still 404 on your box → that app's `.env` is missing
  `AZURE_MAPS_KEY`, or the app was not restarted after the pull.
- `git pull` conflicts → the box has its own local changes; commit or stash
  them first, then pull.
- Road Mention dispatch volume dropped sharply → that is the gate (above).
  Review the Quarantine tab and restore anything that was a real call.
- A restored/real call still shows no map pin with a garbled address
  ("ARMENIA AND COMMANCHE") → misspelling the geocoder can't fuzz past; add
  it to the homophone table rather than the keyword list (hallucination
  lesson: never add noise-prone strings as keywords).

## What is NOT in this update

Machine-specific files stay on each box and are unchanged by this merge:
`AGENTS.md`, the helper bats / detached start scripts, `whisper-model.local`,
`KIMI_RESUME.md`, and all `.env` credentials (gitignored). If you maintain
local edits to shared files, keep them across the pull as usual.
