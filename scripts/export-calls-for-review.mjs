import { MongoClient } from "mongodb";
import "dotenv/config";
import { writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB_NAME || "dispatch_monitor";

if (!uri) {
  console.error("MONGODB_URI not set");
  process.exit(1);
}

const client = new MongoClient(uri);
try {
  await client.connect();
  const db = client.db(dbName);
  const eventsCol = db.collection("dispatchEvents");

  const days = parseInt(process.env.REVIEW_DAYS || "7", 10);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const events = await eventsCol
    .find({ createdAt: { $gte: since } })
    .sort({ createdAt: -1 })
    .project({
      id: 1,
      createdAt: 1,
      transcript: 1,
      signalType: 1,
      address: 1,
      crossStreet: 1,
      district: 1,
      source: 1,
      audioUrl: 1,
      keywords: 1,
    })
    .toArray();

  const outFile = join(
    __dirname,
    "..",
    "shared",
    `calls-for-review-${new Date().toISOString().slice(0, 10)}.json`
  );

  writeFileSync(outFile, JSON.stringify(events, null, 2), "utf-8");

  console.log(`Exported ${events.length} dispatch events from the last ${days} days.`);
  console.log(`Review file: ${outFile}`);
  console.log("\nUse this file to:");
  console.log("  1. Spot-check transcripts for misheard words/phrases.");
  console.log("  2. Identify audio clips worth manually correcting for fine-tuning.");
  console.log("  3. Add missing keywords/street names to Settings -> Keywords.");
} finally {
  await client.close();
}
