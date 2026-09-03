import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const file = join(__dirname, "..", "shared", "calls-for-review-2026-09-01.json");
const events = JSON.parse(readFileSync(file, "utf-8"));

// Florida bounding box (rough)
const FL_LAT_MIN = 24.5, FL_LAT_MAX = 31.0;
const FL_LNG_MIN = -87.6, FL_LNG_MAX = -80.0;

// Hillsborough County bounding box (rough)
const HILLS_LAT_MIN = 27.6, HILLS_LAT_MAX = 28.2;
const HILLS_LNG_MIN = -82.9, HILLS_LNG_MAX = -82.0;

function locationStatus(lat, lng) {
  if (lat == null || lng == null) return "no-gps";
  if (lat >= FL_LAT_MIN && lat <= FL_LAT_MAX && lng >= FL_LNG_MIN && lng <= FL_LNG_MAX) {
    if (lat >= HILLS_LAT_MIN && lat <= HILLS_LAT_MAX && lng >= HILLS_LNG_MIN && lng <= HILLS_LNG_MAX) {
      return "hillsborough";
    }
    return "florida";
  }
  return "out-of-state";
}

function normalizeSource(src) {
  const s = (src || "").toString().toLowerCase().replace(/[-_]/g, " ").trim();
  if (s.includes("disp") && s.includes("1")) return "DISP1";
  if (s.includes("disp") && s.includes("2")) return "DISP2";
  if (s.includes("disp") && s.includes("3")) return "DISP3";
  if (s.includes("disp") && s.includes("4")) return "DISP4";
  if (s.includes("manual")) return "Manual";
  return src || "Unknown";
}

const outOfState = [];
const outOfCounty = [];
const noGps = [];

for (const e of events) {
  const status = locationStatus(e.lat, e.lng);
  e.normalizedSource = normalizeSource(e.source);
  if (status === "out-of-state") outOfState.push(e);
  else if (status === "florida") outOfCounty.push(e);
  else if (status === "no-gps") noGps.push(e);
}

function printList(list, label) {
  console.log(`\n=== ${label} (${list.length}) ===`);
  for (const e of list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 100)) {
    const addr = [e.address, e.crossStreet].filter(Boolean).join(" & ");
    console.log(`#${e.id} [${e.normalizedSource}] ${addr || "(no address)"} | ${e.lat?.toFixed(4)}, ${e.lng?.toFixed(4)} | ${e.geocodedRoad || "no road"}`);
    console.log(`   ${e.transcript.replace(/\n/g, " ").slice(0, 160)}${e.transcript.length > 160 ? "..." : ""}`);
  }
}

printList(outOfState, "OUT OF STATE");
printList(outOfCounty, "IN FLORIDA BUT OUT OF HILLSBOROUGH COUNTY");

console.log(`\n=== SUMMARY ===`);
console.log(`Out of state: ${outOfState.length}`);
console.log(`In Florida, out of Hillsborough: ${outOfCounty.length}`);
console.log(`No GPS: ${noGps.length}`);
console.log(`In Hillsborough: ${events.length - outOfState.length - outOfCounty.length - noGps.length}`);
