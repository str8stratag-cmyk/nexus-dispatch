#!/usr/bin/env node
/**
 * Rule-based Dispatch Call Reconciler (Trial)
 *
 * Pulls recent events from all dispatch feeds, clusters them by time/location,
 * picks the best transcript/address/signal, and emits a single DISP-3 event.
 */

import { MongoClient } from "mongodb";
import "dotenv/config";

const API_URL = process.env.RECONCILER_API_URL || "http://127.0.0.1:5000";
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB_NAME || "dispatch_monitor";
const SOURCE_OUTPUT = "DISP-3";

// Look back window for reconciliation (events newer than this).
const LOOKBACK_MS = parseInt(process.env.RECONCILER_LOOKBACK_MS || "900000", 10); // 15 min
// Time window for clustering events as the same call.
const TIME_WINDOW_MS = parseInt(process.env.RECONCILER_TIME_WINDOW_MS || "600000", 10); // 10 min
// Max distance (km) for events to be considered the same location.
const MAX_DISTANCE_KM = parseFloat(process.env.RECONCILER_MAX_DISTANCE_KM || "1.0");
// Minimum score improvement required to emit a DISP-3 event over existing feeds.
const MIN_SCORE_THRESHOLD = parseInt(process.env.RECONCILER_MIN_SCORE_THRESHOLD || "20", 10);
// How often to run the reconciler loop.
const INTERVAL_MS = parseInt(process.env.RECONCILER_INTERVAL_MS || "180000", 10); // 3 min

if (!MONGODB_URI) {
  console.error("MONGODB_URI not set");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Scoring / normalization helpers
// ---------------------------------------------------------------------------

const SIGNAL_KEYWORDS = [
  "signal 4", "signal four", "signal 3", "signal three", "signal 16",
  "mva", "mvc", "wreck", "crash", "rollover", "airbags deployed",
  "accident", "tow", "rear end damage",
];

const TV_PHRASES = [
  "thank you for watching", "thanks for watching", "that's the end of the video",
  "like and subscribe", "hello hello hello", "today's video", "please return to your seat",
  "visit www", "for more information", "subscribe to our channel",
];

const GENERIC_JUNK_ADDRESSES = new Set([
  "street", "st", "avenue", "ave", "road", "rd", "drive", "dr", "lane", "ln",
  "court", "ct", "circle", "cir", "way", "point", "place", "green", "track",
  "high park", "lowest ave", "college point", "west pass", "front drive",
  "great way", "test way", "entire road", "boat trailer",
]);

const TAMPA_STREETS = [
  "hillsborough", "westshore", "kennedy", "dale mabry", "fowler", "mlk",
  "martin luther king", "adamo", "memorial", "curtis", "osbourne", "bristol",
  "copeland", "prairie", "mcdill", "hyde park", "university center", "lois",
  "brittany", "northdale", "schultenberg", "himes", "boy scout", "floribraska",
  "nebraska", "san miguel", "san miquel",
];

// Whisper/common transcription misspellings -> corrected Tampa street names.
// Add more as you spot them.
// NOTE: Floribraska and Nebraska are both real Tampa streets, so we do NOT
// correct either one.
const ADDRESS_CORRECTIONS = {
  "mcdill": "McDill Blvd",
  "mcdull": "McDill Blvd",
  "macdill": "MacDill Blvd",
  "high park": "Hyde Park",
  "lowest ave": "Lois Ave",
  "lowest avenue": "Lois Ave",
  "mlk": "MLK",
  "mlk blvd": "MLK Blvd",
  "westshore": "Westshore",
  "hillsborough": "Hillsborough",
  "hines": "Himes",
  "boy scout": "Boy Scout Rd",
  "san miquel": "San Miguel",
};

function normalize(text) {
  return (text || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Address cleaning
// ---------------------------------------------------------------------------

const SIGNAL_PREFIXES = [
  /signal\s*4?/gi,
  /signal\s*four/gi,
  /signal\s*3?/gi,
  /signal\s*three/gi,
  /signal\s*16/gi,
  /mva/gi,
  /mvc/gi,
  /wreck/gi,
  /crash/gi,
  /rollover/gi,
  /accident/gi,
  /tow/gi,
];

const INJURY_PHRASES = [
  /with\s+no\s+injuries/gi,
  /with\s+injuries/gi,
  /unknown\s+injuries/gi,
  /no\s+injuries/gi,
];

function stripNoise(text) {
  let cleaned = text;
  for (const re of SIGNAL_PREFIXES) cleaned = cleaned.replace(re, " ");
  for (const re of INJURY_PHRASES) cleaned = cleaned.replace(re, " ");
  // Manual dispatch prefix
  cleaned = cleaned.replace(/manual dispatch\s*:?/gi, " ");
  cleaned = cleaned.replace(/[-—–]+/g, " ");
  return cleaned.replace(/\s+/g, " ").trim();
}

function extractAddressFromTranscript(transcript) {
  const t = transcript || "";

  // Pattern: "at 1234 Street" or "it's 1234 Street" or "be 1234 Street"
  const atMatch = t.match(/(?:\bat\b|\bit'?s\b|\bbe\b)\s+([^,.;]+)/i);
  if (atMatch) {
    const candidate = stripNoise(atMatch[1]);
    if (candidate.length > 3 && !/^\d+$/.test(candidate)) return candidate;
  }

  // Pattern: "Street & Avenue" or "Street and Avenue" or "Street @ Avenue"
  const intersectionMatch = t.match(/([a-z0-9]+(?:\s+[a-z0-9]+){0,5})\s+(?:&|and|@)\s+([a-z0-9]+(?:\s+[a-z0-9]+){0,5})/i);
  if (intersectionMatch) {
    const left = stripNoise(intersectionMatch[1]);
    const right = stripNoise(intersectionMatch[2]);
    if (left && right) return `${left} & ${right}`;
  }

  // Pattern: numeric address (1234 Street Name)
  const numericMatch = t.match(/(\d{1,5}\s+[a-z0-9]+(?:\s+[a-z0-9]+){1,5})/i);
  if (numericMatch) {
    const candidate = stripNoise(numericMatch[1]);
    if (candidate.length > 3) return candidate;
  }

  return null;
}

function cleanAddress(address, transcript) {
  // If the existing address already looks like a real address, just clean noise.
  const hasNumber = /\d/.test(address || "");
  const hasStreet = TAMPA_STREETS.some((s) => normalize(address || "").includes(s));

  let cleaned;
  if (hasNumber && hasStreet) {
    cleaned = stripNoise(address);
  } else {
    // Try to extract a better address from the transcript.
    const extracted = extractAddressFromTranscript(transcript);
    cleaned = extracted || stripNoise(address || "");
  }

  return correctAddressSpelling(cleaned);
}

function splitAddressAndCrossStreet(fullAddress) {
  if (!fullAddress) return { address: null, crossStreet: null };
  const parts = fullAddress.split(/\s+&\s+|\s+and\s+/i).map((s) => s.trim()).filter(Boolean);
  if (parts.length === 2) {
    return { address: parts[0], crossStreet: parts[1] };
  }
  return { address: fullAddress, crossStreet: null };
}

function correctAddressSpelling(address) {
  if (!address) return address;
  let corrected = address;
  const lower = normalize(address);
  for (const [bad, good] of Object.entries(ADDRESS_CORRECTIONS)) {
    const re = new RegExp(`\\b${bad.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
    corrected = corrected.replace(re, good);
  }
  return corrected;
}

function scoreTranscript(event) {
  let score = 0;
  const t = normalize(event.transcript);
  const addr = normalize(event.address);

  // Strong dispatch signals
  for (const kw of SIGNAL_KEYWORDS) {
    if (t.includes(kw)) score += 10;
  }

  // Numeric address is gold
  if (/\d{3,}/.test(addr)) score += 25;
  else if (/\d{1,2}/.test(addr)) score += 10;

  // Known Tampa street names
  for (const street of TAMPA_STREETS) {
    if (addr.includes(street) || t.includes(street)) score += 10;
  }

  // Penalize TV/video audio
  for (const phrase of TV_PHRASES) {
    if (t.includes(phrase)) score -= 30;
  }

  // Penalize generic/junk addresses
  if (addr) {
    const addrWords = addr.split(/\s+/);
    for (const word of addrWords) {
      if (GENERIC_JUNK_ADDRESSES.has(word)) score -= 15;
    }
    if (GENERIC_JUNK_ADDRESSES.has(addr)) score -= 25;
  }

  // Penalize repetitive spam
  if (/\b(\w+)\s+\1\s+\1\s+\1\b/.test(t)) score -= 20;

  // Slight length bonus, capped
  const wordCount = t.split(/\s+/).filter(Boolean).length;
  score += Math.min(wordCount * 0.5, 10);

  return score;
}

function pickBestSignalType(events) {
  const priority = {
    rollover: 6, "airbags deployed": 5, "signal 16": 5, wreck: 4, crash: 4,
    mva: 3, mvc: 3, "signal 4": 2, "signal four": 2, "signal 3": 1,
    "signal three": 1, accident: 1, tow: 0,
  };
  let best = null;
  let bestPrio = -1;
  for (const e of events) {
    const st = normalize(e.signalType);
    for (const [key, val] of Object.entries(priority)) {
      if (st.includes(key) && val > bestPrio) {
        bestPrio = val;
        best = e.signalType;
      }
    }
  }
  return best || events[0]?.signalType || "Signal 4";
}

function pickBestAddress(events) {
  // Prefer the event with the highest score that also has a numeric address.
  const scored = events
    .map((e) => ({ e, score: scoreTranscript(e) }))
    .sort((a, b) => b.score - a.score);
  for (const { e } of scored) {
    const cleaned = cleanAddress(e.address, e.transcript);
    const { address, crossStreet } = splitAddressAndCrossStreet(cleaned);
    if (address && /\d/.test(address)) {
      return { address, crossStreet, lat: e.lat, lng: e.lng };
    }
  }
  // Fallback to highest scorer.
  const cleaned = cleanAddress(scored[0]?.e.address, scored[0]?.e.transcript);
  const { address, crossStreet } = splitAddressAndCrossStreet(cleaned);
  return {
    address: address || scored[0]?.e.address || null,
    crossStreet: crossStreet || scored[0]?.e.crossStreet || null,
    lat: scored[0]?.e.lat || null,
    lng: scored[0]?.e.lng || null,
  };
}

function pickBestTranscript(events) {
  return events
    .map((e) => ({ e, score: scoreTranscript(e) }))
    .sort((a, b) => b.score - a.score)[0]?.e.transcript || events[0]?.transcript || "";
}

// ---------------------------------------------------------------------------
// Clustering
// ---------------------------------------------------------------------------

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLng = (lng2 - lng1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * (Math.PI / 180)) *
      Math.cos(lat2 * (Math.PI / 180)) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function addressSimilarity(a, b) {
  if (!a || !b) return 0;
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return 1;
  const wordsA = new Set(na.split(/\s+/));
  const wordsB = new Set(nb.split(/\s+/));
  const intersection = [...wordsA].filter((w) => wordsB.has(w)).length;
  return intersection / Math.max(wordsA.size, wordsB.size);
}

function sameLocation(a, b) {
  if (a.lat && a.lng && b.lat && b.lng) {
    return haversineKm(a.lat, a.lng, b.lat, b.lng) <= MAX_DISTANCE_KM;
  }
  if (a.address && b.address) {
    return addressSimilarity(a.address, b.address) >= 0.5;
  }
  return false;
}

function clusterEvents(events) {
  const sorted = [...events].sort((a, b) => a.createdAt - b.createdAt);
  const clusters = [];

  for (const event of sorted) {
    let added = false;
    for (const cluster of clusters) {
      const first = cluster[0];
      const timeDiff = Math.abs(event.createdAt - first.createdAt);
      if (timeDiff <= TIME_WINDOW_MS && sameLocation(event, first)) {
        cluster.push(event);
        added = true;
        break;
      }
    }
    if (!added) clusters.push([event]);
  }

  return clusters;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function reconcile() {
  const client = new MongoClient(MONGODB_URI);
  try {
    await client.connect();
    const db = client.db(DB_NAME);
    const eventsCol = db.collection("dispatchEvents");

    const since = new Date(Date.now() - LOOKBACK_MS);
    const events = await eventsCol
      .find({
        createdAt: { $gte: since },
        source: { $ne: SOURCE_OUTPUT }, // don't re-process our own output
      })
      .sort({ createdAt: 1 })
      .toArray();

    if (events.length === 0) {
      console.log("No events to reconcile.");
      return;
    }

    console.log(`Reconciling ${events.length} events from last ${LOOKBACK_MS / 60000} minutes...`);

    const clusters = clusterEvents(events);
    console.log(`Formed ${clusters.length} clusters.`);

    let created = 0;
    let skipped = 0;

    for (const cluster of clusters) {
      const bestScore = Math.max(...cluster.map(scoreTranscript));
      if (bestScore < MIN_SCORE_THRESHOLD) {
        skipped++;
        continue;
      }

      // Check if we already emitted a DISP-3 for this cluster recently.
      const firstTime = cluster[0].createdAt;
      const lastTime = cluster[cluster.length - 1].createdAt;
      const existing = await eventsCol.findOne({
        source: SOURCE_OUTPUT,
        createdAt: {
          $gte: new Date(firstTime.getTime() - TIME_WINDOW_MS),
          $lte: new Date(lastTime.getTime() + TIME_WINDOW_MS),
        },
      });
      if (existing) {
        console.log(`Cluster around ${firstTime.toISOString()} already has DISP-3 event #${existing.id}; skipping.`);
        skipped++;
        continue;
      }

      const transcript = pickBestTranscript(cluster);
      const signalType = pickBestSignalType(cluster);
      const { address, crossStreet, lat, lng } = pickBestAddress(cluster);
      const district = cluster.find((e) => e.district && e.district !== "Unknown")?.district || "District 2";

      const payload = {
        transcript,
        signalType,
        address,
        crossStreet,
        lat,
        lng,
        district,
        source: SOURCE_OUTPUT,
        status: "active",
        isManual: true,
        keywords: "[]",
        description: `Reconciled from ${cluster.length} feed(s): ${[
          ...new Set(cluster.map((e) => e.source)),
        ].join(", ")}`,
      };

      try {
        const res = await fetch(`${API_URL}/api/dispatch`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          const err = await res.text();
          console.error(`Failed to create DISP-3 event: ${res.status} ${err}`);
          continue;
        }
        const result = await res.json();
        created++;
        console.log(
          `Created DISP-3 event #${result.id} from cluster of ${cluster.length} (score ${bestScore})`
        );
      } catch (err) {
        console.error("API call failed:", err.message);
      }
    }

    console.log(`\nDone. Created ${created} DISP-3 events. Skipped ${skipped}.`);
  } finally {
    await client.close();
  }
}

async function main() {
  console.log(`DISP-3 reconciler starting. Interval: ${INTERVAL_MS / 1000}s`);
  while (true) {
    try {
      await reconcile();
    } catch (err) {
      console.error("Reconciler error:", err.message);
    }
    console.log(`Sleeping ${INTERVAL_MS / 1000}s...\n`);
    await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
