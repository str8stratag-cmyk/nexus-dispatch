// Per-source accuracy breakdown of recent dispatch events (last 48h by default).
// Usage: node scripts/accuracy-by-source.mjs [hours]
// Grouped by event `source` (proxy for device/Whisper model until whisperModel tagging lands).
import { MongoClient } from "mongodb";
import "dotenv/config";

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB_NAME || "dispatch_monitor";
const hours = parseInt(process.argv[2] || "48", 10);

if (!uri) {
  console.error("MONGODB_URI not set");
  process.exit(1);
}

const since = new Date(Date.now() - hours * 3600 * 1000);
const client = await MongoClient.connect(uri, { serverSelectionTimeoutMS: 8000 });
const coll = client.db(dbName).collection("dispatchEvents");

const rows = await coll
  .find({ createdAt: { $gte: since } }, { projection: { source: 1, transcript: 1, keywords: 1, lat: 1, signalType: 1, createdAt: 1 } })
  .toArray();

const bySource = new Map();
for (const e of rows) {
  const src = (e.source || "Unknown").toString();
  if (!bySource.has(src)) bySource.set(src, { count: 0, chars: 0, noKeywords: 0, noCoords: 0, signals: new Map() });
  const s = bySource.get(src);
  s.count++;
  s.chars += (e.transcript || "").length;
  if (!e.keywords || e.keywords === "[]") s.noKeywords++;
  if (typeof e.lat !== "number") s.noCoords++;
  const sig = e.signalType || "none";
  s.signals.set(sig, (s.signals.get(sig) || 0) + 1);
}

console.log(`Events since ${since.toISOString()}: ${rows.length}\n`);
for (const [src, s] of [...bySource.entries()].sort((a, b) => b[1].count - a[1].count)) {
  const avgLen = (s.chars / s.count).toFixed(0);
  console.log(`${src}: ${s.count} events | avg transcript ${avgLen} chars | ${s.noKeywords}/${s.count} no-keyword (${((s.noKeywords / s.count) * 100).toFixed(0)}%) | ${s.noCoords}/${s.count} no-coords (${((s.noCoords / s.count) * 100).toFixed(0)}%)`);
  console.log(`  signals: ${[...s.signals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k}=${v}`).join(", ")}`);
}
await client.close();
