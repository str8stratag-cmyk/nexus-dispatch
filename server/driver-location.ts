/**
 * Mongo-backed driver Live Location store + accepted-call arrival tracking.
 * Collections: driverLocations (every fix), driverCalls (one per accepted event).
 */
import { getDatabase, isMongoConfigured } from "./mongodb";
import {
  ARRIVAL_WINDOW_MS,
  evaluateArrival,
  isLocationFresh,
  driverFreshness,
  type AcceptedCallRecord,
  type DriverLocationPoint,
} from "./driver-location-helpers";

let indexesReady: Promise<void> | undefined;
async function db() {
  const d = await getDatabase();
  if (!indexesReady) {
    indexesReady = Promise.all([
      d.collection("driverLocations").createIndex({ telegramUserId: 1, at: -1 }),
      // Keep 30 days of raw fixes.
      d.collection("driverLocations").createIndex({ createdAt: 1 }, { expireAfterSeconds: 30 * 86400 }),
      d.collection("driverCalls").createIndex({ eventId: 1 }, { unique: true }),
      d.collection("driverCalls").createIndex({ telegramUserId: 1, status: 1 }),
    ]).then(() => undefined).catch((e) => { indexesReady = undefined; throw e; });
  }
  await indexesReady;
  return d;
}

export async function recordDriverLocation(p: DriverLocationPoint): Promise<void> {
  if (!isMongoConfigured) return;
  const d = await db();
  await d.collection("driverLocations").insertOne({ ...p, createdAt: new Date() });
  // Resolve any pending calls for this driver right away.
  const pending = await d.collection("driverCalls").find({ telegramUserId: p.telegramUserId, status: "pending" }).toArray();
  for (const c of pending) await refreshCall(c as any);
}

export async function getLastDriverLocation(telegramUserId: number): Promise<DriverLocationPoint | null> {
  if (!isMongoConfigured) return null;
  const d = await db();
  const doc = await d.collection("driverLocations").find({ telegramUserId }).sort({ at: -1 }).limit(1).next();
  return (doc as any) ?? null;
}

export async function recordAcceptedCall(rec: Omit<AcceptedCallRecord, "status">): Promise<void> {
  if (!isMongoConfigured) return;
  const d = await db();
  await d.collection("driverCalls").updateOne(
    { eventId: rec.eventId },
    { $setOnInsert: { ...rec, status: "pending", arrivedAt: null, closestM: null, createdAt: new Date() } },
    { upsert: true },
  );
}

async function refreshCall(c: AcceptedCallRecord): Promise<AcceptedCallRecord> {
  if (c.status !== "pending") return c;
  const d = await db();
  const points = c.telegramUserId == null ? [] : await d.collection("driverLocations")
    .find({ telegramUserId: c.telegramUserId, at: { $gte: c.acceptedAt, $lte: c.acceptedAt + ARRIVAL_WINDOW_MS } })
    .project({ lat: 1, lon: 1, at: 1 }).toArray();
  const r = evaluateArrival(c, points as any, Date.now());
  if (r.status !== c.status || r.closestM !== c.closestM) {
    await d.collection("driverCalls").updateOne({ eventId: c.eventId, status: "pending" }, { $set: r });
  }
  return { ...c, ...r };
}

export async function driverBoard(now = Date.now()) {
  if (!isMongoConfigured) return { drivers: [], calls: [] };
  const d = await db();
  const drivers = await d.collection("driverLocations").aggregate([
    { $match: { at: { $gte: now - 7 * 86400_000 } } },
    { $sort: { at: -1 } },
    { $group: { _id: "$telegramUserId", last: { $first: "$$ROOT" } } },
  ]).toArray();
  const callDocs = await d.collection("driverCalls").find({}).sort({ acceptedAt: -1 }).limit(100).toArray();
  const calls = [];
  for (const c of callDocs) calls.push(await refreshCall(c as any));
  return {
    drivers: drivers.map((g: any) => {
      const l = g.last as DriverLocationPoint;
      return {
        telegramUserId: l.telegramUserId,
        driverName: l.driverName,
        lat: l.lat,
        lon: l.lon,
        heading: l.heading,
        livePeriod: l.livePeriod,
        at: new Date(l.at).toISOString(),
        ageSec: Math.round((now - l.at) / 1000),
        fresh: isLocationFresh(l, now),
        freshness: driverFreshness(now - l.at),
      };
    }),
    calls: calls.map((c: any) => ({
      eventId: c.eventId,
      driverName: c.driverName,
      telegramUserId: c.telegramUserId,
      address: c.address,
      lat: c.lat,
      lng: c.lng,
      acceptedAt: new Date(c.acceptedAt).toISOString(),
      status: c.status,
      arrivedAt: c.arrivedAt ? new Date(c.arrivedAt).toISOString() : null,
      closestM: c.closestM ?? null,
    })),
  };
}
