// E2E dry-run for the street-dictionary correlation (no events created).
// For each garbled address: (1) geocode it via the LIVE /api/geocode chain —
// the same chain /api/dispatch uses, including provider match-validation;
// (2) run the matcher; (3) geocode the corrected address. Pass criteria per
// case. Requires the app on :5000 (npm run dev).
//
// Run: npx tsx trial/test-street-correlation.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { suggestStreets, type StreetDictionary } from "../shared/street-match";

const BASE = process.env.APP_URL ?? "http://127.0.0.1:5000";
const dict = JSON.parse(
  readFileSync(join(process.cwd(), "shared", "tampa-street-dictionary.json"), "utf8"),
) as StreetDictionary;

interface Case {
  input: string;
  /** lowercase fragment expected in the suggested canonical name */
  expect: string | null;
  /** true = a suggestion is enough even if corrected geocode fails */
  suggestOnly?: boolean;
}

const CASES: Case[] = [
  // Real quarantine samples
  { input: "1406 north delmarie highway", expect: "delmar", suggestOnly: true },
  { input: "us 31", expect: "us 301" },
  // Regression junk — must suggest nothing
  { input: "i m gonna back alley", expect: null },
  { input: "swan and boulevard", expect: null },
  { input: "ever od 886 mount ferguson", expect: null },
  // Synthesized Whisper-style garbles of real streets (NOT covered by the
  // upstream KNOWN_ROAD_CANONICAL homophones, so the matcher is what saves them)
  { input: "habanna avenue", expect: "habana" },
  { input: "1560 north highlend avenue", expect: "highland" },
  { input: "1280 van dike rd", expect: "van dyke" },
  { input: "600 spruse street", expect: "spruce" },
  // Informational: upstream homophones already fix this before the matcher
  { input: "azeele amd tampania", expect: "azeele" },
];

async function geocode(q: string): Promise<{ ok: boolean; status: number; lat?: number; lng?: number; provider?: string }> {
  try {
    const res = await fetch(`${BASE}/api/geocode?q=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(20000) });
    if (res.ok) {
      const body = await res.json();
      return { ok: true, status: res.status, lat: body.lat, lng: body.lng, provider: body.provider };
    }
    return { ok: false, status: res.status };
  } catch (err: any) {
    return { ok: false, status: 0 };
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;

for (const c of CASES) {
  const before = await geocode(c.input);
  const [suggestion] = suggestStreets(c.input, dict);
  const after = suggestion ? await geocode(suggestion.correctedAddress) : null;
  await sleep(300); // be polite to providers

  let verdict: string;
  let good: boolean;
  if (c.expect === null) {
    good = !suggestion;
    verdict = good ? "PASS (no suggestion)" : `FAIL (junk suggested: ${suggestion?.correctedAddress})`;
  } else if (!suggestion) {
    good = before.ok; // acceptable only if the live chain already handled it
    verdict = good ? "PASS (geocode-ok upstream, matcher idle)" : "FAIL (no suggestion, garbled geocode failed)";
  } else {
    const nameOk = suggestion.name.toLowerCase().includes(c.expect);
    if (!nameOk) {
      good = false;
      verdict = `FAIL (suggested ${suggestion.correctedAddress}, wanted ~${c.expect})`;
    } else if (after?.ok) {
      good = true;
      verdict = `PASS (${suggestion.score} -> geocoded ${after.lat?.toFixed(4)},${after.lng?.toFixed(4)} via ${after.provider})`;
    } else if (c.suggestOnly) {
      good = true;
      verdict = `PASS (suggested ${suggestion.correctedAddress} @ ${suggestion.score}; corrected geocode pending)`;
    } else {
      good = false;
      verdict = `FAIL (suggested ${suggestion.correctedAddress} @ ${suggestion.score} but corrected geocode ${after?.status})`;
    }
  }

  if (good) pass++;
  else fail++;
  console.log(`${good ? "ok  " : "FAIL"} | ${c.input}`);
  console.log(`      garbled geocode: ${before.ok ? `200 ${before.provider}` : before.status} | ${verdict}`);
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
