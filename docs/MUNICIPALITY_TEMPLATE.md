# Municipality transfer template

Use this when standing up Dispatch Monitor (or a white-label sibling) for a new county/city. Copy into the municipality’s repo and fill every `TBD`. **Never commit real bot tokens, Mongo URIs with passwords, or API keys** — put those in `.env` / secrets manager.

Reference implementation: [`str8stratag-cmyk/dispatch-monitor`](https://github.com/str8stratag-cmyk/dispatch-monitor) (Hillsborough / Tampa fleet). Thin starter: [`dispatch-monitor-municipality-template`](https://github.com/str8stratag-cmyk/dispatch-monitor-municipality-template).

---

## Identity

| Field | Value |
|-------|--------|
| County / City name | TBD |
| State | TBD |
| Short code (repo / DB prefix) | TBD (e.g. `polk`, `hills`) |
| Timezone | America/New_York (or TBD) |
| Go-live target week | TBD |

## Geography

| Field | Value |
|-------|--------|
| Primary city for geocode suffix (`GEOCODE_SUFFIX`) | TBD (e.g. `Lakeland, FL`) |
| Bounding box `west,south,east,north` (`GEOAPIFY_BOUNDING_BOX`) | TBD |
| Map default center lat/lng + zoom | TBD |
| Street dictionary source / file | TBD (replace `tampa-street-dictionary.json`) |
| Known major corridors / aliases to seed | TBD |

## Radio / capture

| Field | Value |
|-------|--------|
| Primary radio sources / feeds | TBD |
| Backup sources | TBD |
| Capture desk hostnames → DISP-N map | TBD |
| Mic / feed routing notes | TBD |

## Keyword pack

| Field | Value |
|-------|--------|
| Core crash/tow keywords (keep from `shared/keywords.ts`) | Signal 3/4/16, MVA/MVC, crash, wreck, tow, flatbed, … |
| Local signal codes / slang | TBD |
| Known Whisper mishearings to add week 1 | TBD |
| Road Mention enabled? (needs second-signal gate) | TBD |

## Alerts / ops

| Field | Value |
|-------|--------|
| Telegram ops chat (name, not id in git) | TBD |
| Telegram bot name | TBD |
| Accept poll desk (exactly one) | TBD |
| Webhook URL (if any) | TBD / none |
| On-call / escalation contact | TBD |

## Whisper / compute

| Field | Value |
|-------|--------|
| Whisper endpoint strategy | local CPU / shared GPU / hybrid failover |
| Remote Whisper URL placeholder name | e.g. `WHISP-1` or new GPU box |
| Model | prefer fleet lessons: `small.en` unless justified |
| Failover enabled? | TBD |

## Data

| Field | Value |
|-------|--------|
| Mongo cluster / DB namespace | TBD (isolate from Hillsborough board) |
| Retention policy | TBD |
| Admin auth (`ADMIN_SECRET` present?) | TBD |

## Branding / legal

| Field | Value |
|-------|--------|
| Product / white-label name | TBD |
| Logo / colors | TBD |
| Scanner / radio legal notes | TBD |
| PII / recording retention | TBD |

---

## Polk County (next)

Worked blank for **week of Oct 2026** — first separate-app consumer.

| Field | Polk value |
|-------|------------|
| County / City name | **Polk County, FL** (cities: Lakeland, Winter Haven, … — TBD primary) |
| Short code | `polk` |
| Repo | `str8stratag-cmyk/dispatch-monitor-polk` |
| `GEOCODE_SUFFIX` | TBD — candidates: `Lakeland, FL` / `Winter Haven, FL` / `Polk County, FL` |
| Bounding box `west,south,east,north` | TBD (do not reuse Tampa Bay example from Hillsborough `.env.example`) |
| Map default center | TBD (Lakeland area approx — confirm before hardcoding) |
| Street dictionary | TBD — generate Polk roads; do not ship `tampa-street-dictionary.json` as-is |
| Radio sources | **TBD this week** (Zach / ops) |
| Keyword pack | Start from core crash/tow list; add Polk Sheriff / municipal codes after first captures |
| Telegram ops chat | TBD (create dedicated Polk chat — do not reuse Hillsborough chat without decision) |
| Whisper | TBD — local vs shared GPU (WHISP-1 or new) |
| Mongo DB namespace | TBD — **separate** from `str8stratag_db_user` Hillsborough board |
| Branding | TBD |
| Legal notes | TBD |
| Owner for secrets fill | Zach |
| Target | Begin separate Polk app **week of Oct 2026** |

### Polk checklist (this week)

- [ ] Confirm primary city for geocode suffix + bbox
- [ ] List radio feeds / talkgroups
- [ ] Create Telegram bot + Polk ops chat
- [ ] Provision Mongo DB/namespace
- [ ] Decide Whisper topology
- [ ] Generate initial street dictionary
- [ ] Seed repo from municipality template
- [ ] First desk identity + dry-run capture
