import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const file = join(__dirname, "..", "shared", "calls-for-review-2026-09-01.json");
const events = JSON.parse(readFileSync(file, "utf-8"));

function normalizeSource(src) {
  const s = (src || "").toString().toLowerCase().replace(/[-_]/g, " ").trim();
  if (s.includes("disp") && s.includes("1")) return "DISP1";
  if (s.includes("disp") && s.includes("2")) return "DISP2";
  if (s.includes("disp") && s.includes("3")) return "DISP3";
  if (s.includes("disp") && s.includes("4")) return "DISP4";
  if (s.includes("manual")) return "Manual";
  if (s.includes("auto")) return "Auto";
  return src || "Unknown";
}

const TAMPA_STREETS = new Set([
  "hillsborough", "westshore", "kennedy", "dale mabry", "fowler", "mlk",
  "martin luther king", "adamo", "memorial", "curtis", "osbourne", "bristol",
  "copeland", "prairie", "mcdill", "macdill", "hyde park", "university center", "lois",
  "brittany", "northdale", "schultenberg", "himes", "hines", "hives", "boy scout", "floribraska",
  "nebraska", "san miguel", "san miquel", "beach", "george j bean", "george j. bean",
  "parkway", "nassau", "mc dill", "macdill ave", "mcdill ave", "south tampa", "tampa",
  "ybor", "channelside", "downtown", "interstate", "i 4", "i 75", "i 275", "us 10",
]);

const knownBadWords = new Set([
  "hives", "hines", "mcdull", "high park", "lowest ave", "lowest avenue",
  "san miquel", "miquel", "miguel",
]);

function norm(text) {
  return (text || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function findPotentialMisspellings(transcript, address, crossStreet) {
  const t = norm(transcript);
  const found = [];
  for (const word of knownBadWords) {
    if (t.includes(word)) found.push(word);
  }
  // Find standalone street-like words not in known Tampa list
  const words = t.split(" ");
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w.length < 3) continue;
    const next = words[i + 1] || "";
    const bigram = w + " " + next;
    if (TAMPA_STREETS.has(bigram)) continue;
    if (TAMPA_STREETS.has(w)) continue;
    // crude heuristic: word looks like a name and is followed by st/ave/rd/blvd
    if (["st", "ave", "rd", "blvd", "dr", "ln", "ct", "cir", "way", "pkwy", "hwy", "boulevard"].includes(next)) {
      found.push(w + " " + next);
    }
  }
  return [...new Set(found)];
}

const bySource = {};
for (const e of events) {
  const src = normalizeSource(e.source);
  e.normalizedSource = src;
  bySource[src] = (bySource[src] || 0) + 1;
}

console.log("=== SOURCE COUNTS (normalized) ===");
for (const [k, v] of Object.entries(bySource).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k}: ${v}`);
}

// Most recent 50 calls
console.log("\n=== LAST 50 CALLS ===");
const recent = [...events].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 50);
for (const e of recent) {
  const addr = [e.address, e.crossStreet].filter(Boolean).join(" & ");
  console.log(`#${e.id} [${e.normalizedSource}] ${new Date(e.createdAt).toLocaleString()} | ${e.signalType || "n/a"} | ${addr}`);
  console.log(`   ${e.transcript.replace(/\n/g, " ")}`);
}

// Potential misspellings
console.log("\n=== POTENTIAL MISSPELLINGS / ADDRESS FLAGS ===");
const flagged = events
  .map(e => ({ e, misspellings: findPotentialMisspellings(e.transcript, e.address, e.crossStreet) }))
  .filter(({ misspellings }) => misspellings.length > 0)
  .sort((a, b) => new Date(b.e.createdAt) - new Date(a.e.createdAt))
  .slice(0, 100);

for (const { e, misspellings } of flagged) {
  const addr = [e.address, e.crossStreet].filter(Boolean).join(" & ");
  console.log(`#${e.id} [${e.normalizedSource}] ${addr} | flags: ${misspellings.join(", ")}`);
  console.log(`   ${e.transcript.replace(/\n/g, " ")}`);
}

// DISP2 vs DISP4 comparison: group by similar transcript/address/signal within 10 min
console.log("\n=== DISP2 vs DISP4 SAME-CALL COMPARISON ===");
const disp2 = events.filter(e => e.normalizedSource === "DISP2").sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
const disp4 = events.filter(e => e.normalizedSource === "DISP4").sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

const matched = [];
for (const e2 of disp2) {
  const t2 = norm(e2.transcript);
  const candidates = disp4.filter(e4 => Math.abs(new Date(e4.createdAt) - new Date(e2.createdAt)) < 10 * 60 * 1000);
  for (const e4 of candidates) {
    const t4 = norm(e4.transcript);
    // same signal type or address overlap
    const signalMatch = e2.signalType && e4.signalType && e2.signalType === e4.signalType;
    const addrMatch = (e2.address && e4.address && norm(e2.address) === norm(e4.address)) ||
                      (e2.crossStreet && e4.crossStreet && norm(e2.crossStreet) === norm(e4.crossStreet));
    if (signalMatch || addrMatch) {
      matched.push({ e2, e4 });
      break;
    }
  }
}

for (const { e2, e4 } of matched.slice(-30)) {
  console.log(`\nPair: DISP2 #${e2.id} vs DISP4 #${e4.id} (${new Date(e2.createdAt).toLocaleTimeString()})`);
  console.log(`  DISP2 addr: ${e2.address || ""}${e2.crossStreet ? " & " + e2.crossStreet : ""}`);
  console.log(`       trnsc: ${e2.transcript.replace(/\n/g, " ")}`);
  console.log(`  DISP4 addr: ${e4.address || ""}${e4.crossStreet ? " & " + e4.crossStreet : ""}`);
  console.log(`       trnsc: ${e4.transcript.replace(/\n/g, " ")}`);
}
