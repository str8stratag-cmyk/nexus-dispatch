// One-shot generator for the Tampa/Hillsborough street dictionary used by
// shared/street-match.ts. Queries OSM Overpass for named highways inside the
// dispatch bbox, normalizes, folds in the curated KNOWN_ROAD_CANONICAL names,
// and writes shared/tampa-street-dictionary.json. Commit the output — runtime
// never calls Overpass.
//
// Run: npx tsx scripts/generate-street-dictionary.ts
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { normalizeStreet } from "../shared/street-match";

// Tampa / Hillsborough dispatch area (Tampa, Temple Terrace, Brandon,
// Riverview, Plant City edge). South,north,west,east order.
const BBOX = "27.60,-82.80,28.30,-82.00";
const QUERY = `[out:json][timeout:240];way["highway"]["name"](${BBOX});out tags;`;
const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.nchc.org.tw/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];
const UA = "DispatchMonitor street-dictionary generator (one-shot, local)";

// Canonical names curated in server/routes.ts KNOWN_ROAD_CANONICAL — folded in
// so hand-tuned aliases survive even if OSM spells them differently.
const CURATED = [
  "Florida Ave", "Nebraska Ave", "Hillsborough Ave", "Fowler Ave", "Fletcher Ave",
  "Waters Ave", "Himes Ave", "Hale Ave", "Dale Mabry Hwy", "Columbus Ave",
  "Armenia Ave", "MacDill Ave", "Platt St", "Channelside Dr", "Adamo Dr",
  "Riverview Dr", "Brandon Blvd", "Bearss Ave", "Gunn Hwy", "Bruce B Downs Blvd",
  "Ehrlich Rd", "Osborne Ave", "Comanche Ave", "Ola Ave", "Wilder Ave",
  "Livingston Ave", "Memorial Highway", "Morris Bridge Rd",
  "Martin Luther King Jr Blvd", "Busch Blvd", "Sligh Ave", "Kennedy Blvd",
  "Broadway Ave", "Bayshore Blvd", "West Shore Blvd", "Gandy Blvd",
  "Bay to Bay Blvd", "Grady Ave", "Manhattan Ave", "Alva St",
  "15th St", "22nd St", "30th St", "40th St", "50th St", "56th St",
  "Azeele St", "Tampania Ave", "Amberly Dr", "Elmer St", "Orient Rd",
  "Melbourne Blvd",
];

function preferredName(a: string, b: string): string {
  // Same stem, competing canonical forms: prefer one carrying a street-type
  // suffix; otherwise the shorter name.
  const hasSuffix = (n: string) => /\b(st|ave|rd|blvd|dr|ln|ct|cir|hwy|pkwy|pl|ter|trl|way)\b\.?$/i.test(n);
  if (hasSuffix(a) !== hasSuffix(b)) return hasSuffix(a) ? a : b;
  return a.length <= b.length ? a : b;
}

// Words that are ONLY a street type. Stems made of nothing but these are
// junk entries ("Court Way", "E Street", "Boulevard") — they let garbage
// addresses that happen to BE type-words auto-restore as real events.
const TYPE_ONLY_WORDS = new Set([
  "st", "street", "ave", "avenue", "rd", "road", "blvd", "boulevard", "dr",
  "drive", "ln", "lane", "ct", "court", "cir", "circle", "hwy", "highway",
  "pkwy", "parkway", "pl", "place", "ter", "terrace", "trl", "trail", "way",
  "run", "path", "row", "alley", "bridge", "walk", "cove", "loop", "crossing",
  "causeway", "rdg", "ridge", "expy", "expressway",
]);

function isTypeOnlyStem(stem: string): boolean {
  const tokens = stem.split(" ").filter(Boolean);
  return tokens.length === 0 || tokens.every((t) => TYPE_ONLY_WORDS.has(t));
}

async function fetchOverpass(): Promise<any> {
  let lastErr: unknown = null;
  for (const endpoint of ENDPOINTS) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        // GET with ?data= — several public instances 406 a bare form POST.
        const res = await fetch(`${endpoint}?data=${encodeURIComponent(QUERY)}`, {
          headers: { "User-Agent": UA, Accept: "application/json" },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
      } catch (err) {
        lastErr = err;
        console.warn(`Overpass endpoint ${endpoint} attempt ${attempt} failed: ${(err as Error).message}`);
        if ((err as Error).message.includes("429") && attempt === 1) {
          await new Promise((r) => setTimeout(r, 8000));
        } else {
          break;
        }
      }
    }
  }
  throw lastErr ?? new Error("all Overpass endpoints failed");
}

const json = await fetchOverpass();
const names = new Set<string>();
for (const el of json.elements ?? []) {
  const rawName: string | undefined = el?.tags?.name;
  if (!rawName) continue;
  for (const part of rawName.split(/[;/]/)) {
    const clean = part.replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s+/g, " ").trim();
    if (clean.length >= 3) names.add(clean);
  }
}
for (const n of CURATED) names.add(n);

const stems: Record<string, string> = {};
for (const name of names) {
  const stem = normalizeStreet(name);
  if (stem.length < 3) continue;
  if (/^\d+$/.test(stem)) continue; // bare block numbers aren't streets
  if (isTypeOnlyStem(stem)) continue; // "Court Way", "E Street", "Boulevard"
  stems[stem] = stem in stems ? preferredName(stems[stem], name) : name;
}

const dictionary = {
  generatedAt: new Date().toISOString(),
  source: `OSM Overpass way[highway][name] bbox(${BBOX}) + KNOWN_ROAD_CANONICAL curated names`,
  bbox: BBOX,
  names: [...names].sort(),
  stems,
};

const outPath = join(dirname(fileURLToPath(import.meta.url)), "..", "shared", "tampa-street-dictionary.json");
writeFileSync(outPath, JSON.stringify(dictionary));
console.log(`elements=${(json.elements ?? []).length} names=${dictionary.names.length} stems=${Object.keys(stems).length}`);
console.log(`wrote ${outPath}`);
