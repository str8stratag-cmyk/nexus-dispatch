/**
 * Mongo-backed daily check-in + eligibility (DRIVER_LOCATION_GATE).
 * Collections: driverCheckins (one per driver per local date),
 * driverReminders (last expiry reminder per driver per date).
 */
import { getDatabase, isMongoConfigured } from "./mongodb";
import { getLastDriverLocation } from "./driver-location";
import { evaluateEligibility, localClock, type CheckinConfig, type Eligibility, type RosterRow } from "./driver-checkin-helpers";

let indexesReady: Promise<void> | undefined;
async function db() {
  const d = await getDatabase();
  if (!indexesReady) {
    indexesReady = Promise.all([
      d.collection("driverCheckins").createIndex({ date: 1, telegramUserId: 1 }, { unique: true }),
      d.collection("driverCheckins").createIndex({ createdAt: 1 }, { expireAfterSeconds: 60 * 86400 }),
      d.collection("driverReminders").createIndex({ date: 1, telegramUserId: 1 }, { unique: true }),
      d.collection("driverReminders").createIndex({ createdAt: 1 }, { expireAfterSeconds: 7 * 86400 }),
    ]).then(() => undefined).catch((e) => { indexesReady = undefined; throw e; });
  }
  await indexesReady;
  return d;
}

/** Record a check-in. Returns true if newly checked in, false if already in. */
export async function recordCheckin(date: string, telegramUserId: number, driverName: string): Promise<boolean> {
  if (!isMongoConfigured) return false;
  const d = await db();
  const r = await d.collection("driverCheckins").updateOne(
    { date, telegramUserId },
    { $setOnInsert: { date, telegramUserId, driverName, at: Date.now(), createdAt: new Date() } },
    { upsert: true },
  );
  return r.upsertedCount > 0;
}

export async function isCheckedIn(date: string, telegramUserId: number): Promise<boolean> {
  if (!isMongoConfigured) return false;
  const d = await db();
  return (await d.collection("driverCheckins").countDocuments({ date, telegramUserId }, { limit: 1 })) > 0;
}

export async function driverEligibility(telegramUserId: number, cfg: CheckinConfig, now = Date.now()): Promise<Eligibility> {
  const { date } = localClock(now, cfg.timeZone);
  const [inToday, last] = await Promise.all([isCheckedIn(date, telegramUserId), getLastDriverLocation(telegramUserId)]);
  return evaluateEligibility(inToday, last, now, cfg.freshMs);
}

/** Roster for today: everyone checked in + anyone with a fix in the last 24h. */
export async function checkinRoster(cfg: CheckinConfig, now = Date.now()): Promise<{ date: string; rows: RosterRow[] }> {
  const { date } = localClock(now, cfg.timeZone);
  if (!isMongoConfigured) return { date, rows: [] };
  const d = await db();
  const checkins = await d.collection("driverCheckins").find({ date }).toArray();
  const lasts = await d.collection("driverLocations").aggregate([
    { $match: { at: { $gte: now - 86400_000 } } },
    { $sort: { at: -1 } },
    { $group: { _id: "$telegramUserId", last: { $first: "$$ROOT" } } },
  ]).toArray();
  const byId = new Map<number, any>(lasts.map((g: any) => [g._id, g.last]));
  const ids = new Set<number>(checkins.map((c: any) => c.telegramUserId).concat(Array.from(byId.keys())));
  const inSet = new Set<number>(checkins.map((c: any) => c.telegramUserId));
  const rows: RosterRow[] = [];
  for (const id of Array.from(ids)) {
    const last = byId.get(id) ?? (inSet.has(id) ? await getLastDriverLocation(id) : null);
    const name = last?.driverName ?? checkins.find((c: any) => c.telegramUserId === id)?.driverName ?? `User ${id}`;
    rows.push({
      telegramUserId: id,
      driverName: name,
      checkedIn: inSet.has(id),
      lastFixAt: last?.at ?? null,
      status: evaluateEligibility(inSet.has(id), last, now, cfg.freshMs),
    });
  }
  rows.sort((a, b) => a.driverName.localeCompare(b.driverName));
  return { date, rows };
}

export async function getReminder(date: string, telegramUserId: number): Promise<{ lastAt: number; forFixAt: number | null } | null> {
  if (!isMongoConfigured) return null;
  const d = await db();
  const doc: any = await d.collection("driverReminders").findOne({ date, telegramUserId });
  return doc ? { lastAt: doc.lastAt, forFixAt: doc.forFixAt ?? null } : null;
}

export async function setReminder(date: string, telegramUserId: number, lastAt: number, forFixAt: number | null): Promise<void> {
  if (!isMongoConfigured) return;
  const d = await db();
  await d.collection("driverReminders").updateOne(
    { date, telegramUserId },
    { $set: { lastAt, forFixAt }, $setOnInsert: { createdAt: new Date() } },
    { upsert: true },
  );
}
