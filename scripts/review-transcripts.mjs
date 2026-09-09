import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const file = join(__dirname, "..", "shared", "calls-for-review-2026-09-03.json");
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
  "busch", "del ray", "delray", "del rey", "del rey ct", "delray dr", "del ray ct", "del ray dr",
]);

const knownBadWords = new Set([
  "hives", "hines", "mcdull", "high park", "lowest ave", "lowest avenue",
  "san miquel", "miquel", "miguel", "braska",
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

// DISP1/DISP2/DISP4 comparison: group by similar transcript/address/signal within 10 min
console.log("\n=== DISP1/DISP2/DISP4 SAME-CALL COMPARISON ===");

function feedEvents(name) {
  return events
    .filter(e => e.normalizedSource === name)
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
}

const feeds = ["DISP1", "DISP2", "DISP4"]
  .map(name => ({ name, events: feedEvents(name) }))
  .filter(f => f.events.length > 0);

const matched = [];
for (let i = 0; i < feeds.length; i++) {
  for (let j = i + 1; j < feeds.length; j++) {
    const A = feeds[i];
    const B = feeds[j];
    for (const eA of A.events) {
      const tA = norm(eA.transcript);
      const candidates = B.events.filter(eB => Math.abs(new Date(eB.createdAt) - new Date(eA.createdAt)) < 10 * 60 * 1000);
      for (const eB of candidates) {
        const tB = norm(eB.transcript);
        // same signal type or address overlap
        const signalMatch = eA.signalType && eB.signalType && eA.signalType === eB.signalType;
        const addrMatch = (eA.address && eB.address && norm(eA.address) === norm(eB.address)) ||
                          (eA.crossStreet && eB.crossStreet && norm(eA.crossStreet) === norm(eB.crossStreet));
        if (signalMatch || addrMatch) {
          matched.push({ a: A.name, aEvent: eA, b: B.name, bEvent: eB });
          break;
        }
      }
    }
  }
}

for (const { a, aEvent, b, bEvent } of matched.slice(-40)) {
  const fmt = (e) => `${e.address || ""}${e.crossStreet ? " & " + e.crossStreet : ""}`;
  console.log(`\nPair: ${a} #${aEvent.id} vs ${b} #${bEvent.id} (${new Date(aEvent.createdAt).toLocaleTimeString()})`);
  console.log(`  ${a} addr: ${fmt(aEvent)}`);
  console.log(`      trnsc: ${aEvent.transcript.replace(/\n/g, " ")}`);
  console.log(`  ${b} addr: ${fmt(bEvent)}`);
  console.log(`      trnsc: ${bEvent.transcript.replace(/\n/g, " ")}`);
}
