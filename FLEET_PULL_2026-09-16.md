# Fleet Post-Pull Runbook — Nexus 2026-09-16 update

This repo received the Azure-primary geocoder and creation-time coordinate
pinning: `POST /api/dispatch` now resolves coordinates when the client did
not send them, so manual entries (submitted with lat/lng null) and auto
events from non-geocoding clients no longer land coord-less in the shared
fleet DB. The geocoder chain (Azure Maps → Geoapify → Nominatim, shared
Florida service-area bounds) was extracted into `geocodeAddress()` and is
used by both `/api/geocode` and dispatch creation. Also fixed: addresses
containing the road name "Florida" (e.g. "Florida Ave") no longer lose their
"Tampa, FL" context and get rejected as out-of-state.

The full fleet-wide steps and behavior notes live in the same-named file at
the dispatch-monitor repo root (`FLEET_PULL_2026-09-16.md`) — read that too.

```bash
cd ~/nexus-dispatch && git pull && npm install && npm run check
# restart your Nexus service (watchdog boxes: automatic), then:

curl -s -G http://127.0.0.1:5001/api/geocode --data-urlencode "q=Florida Ave"
# expect provider "azure-maps" + Tampa coords (was: 404 / outside service area)
```

One-time per box: put the fleet `AZURE_MAPS_KEY` in `.env` (names documented
in `.env.example`). Without it Nexus still runs, but geocoding falls back to
Geoapify/Nominatim. Machine-specific files (`AGENTS.md`, helper scripts,
`whisper-model.local`, `.env`) are not part of this update and stay local.
