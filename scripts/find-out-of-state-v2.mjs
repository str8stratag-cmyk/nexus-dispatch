import { MongoClient } from "mongodb";
import "dotenv/config";

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB_NAME || "dispatch_monitor";

const client = new MongoClient(uri);
try {
  await client.connect();
  const db = client.db(dbName);
  const eventsCol = db.collection("dispatchEvents");

  const events = await eventsCol
    .find({ lat: { $ne: null } })
    .sort({ createdAt: -1 })
    .limit(1000)
    .project({
      id: 1, createdAt: 1, transcript: 1, signalType: 1,
      address: 1, crossStreet: 1, source: 1, lat: 1, lng: 1,
      geocodedRoad: 1,
    })
    .toArray();

  // Florida rough box
  const FL_LAT_MIN = 24.5, FL_LAT_MAX = 31.0;
  const FL_LNG_MIN = -87.6, FL_LNG_MAX = -80.0;
  // Hillsborough rough box
  const HILLS_LAT_MIN = 27.6, HILLS_LAT_MAX = 28.2;
  const HILLS_LNG_MIN = -82.9, HILLS_LNG_MAX = -82.0;

  function locationStatus(lat, lng) {
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

  for (const e of events) {
    const status = locationStatus(e.lat, e.lng);
    e.normalizedSource = normalizeSource(e.source);
    if (status === "out-of-state") outOfState.push(e);
    else if (status === "florida") outOfCounty.push(e);
  }

  function printList(list, label) {
    console.log(`\n=== ${label} (${list.length}) ===`);
    for (const e of list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))) {
      const addr = [e.address, e.crossStreet].filter(Boolean).join(" & ");
      console.log(`#${e.id} [${e.normalizedSource}] ${addr || "(no address)"} | ${e.lat?.toFixed(4)}, ${e.lng?.toFixed(4)} | road: ${e.geocodedRoad || "n/a"}`);
      console.log(`   ${e.transcript.replace(/\n/g, " ").slice(0, 180)}${e.transcript.length > 180 ? "..." : ""}`);
    }
  }

  printList(outOfState, "OUT OF STATE");
  printList(outOfCounty, "IN FLORIDA, OUT OF HILLSBOROUGH");

  console.log(`\n=== SUMMARY ===`);
  console.log(`Total with GPS: ${events.length}`);
  console.log(`Out of state: ${outOfState.length}`);
  console.log(`In Florida, out of Hillsborough: ${outOfCounty.length}`);
  console.log(`In Hillsborough: ${events.length - outOfState.length - outOfCounty.length}`);
} finally {
  await client.close();
}
