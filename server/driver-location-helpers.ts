/**
 * Pure helpers for driver Live Location tracking (Telegram) and call-arrival
 * verification. Free of Express/Mongo so trial tests can import directly.
 */

/** Distance (m) that counts as "on scene". */
export const ARRIVAL_RADIUS_M = 200;
/** How long after Accept a driver has to reach the call site. */
export const ARRIVAL_WINDOW_MS = 60 * 60_000;
/** A location older than this is not "fresh" for the Accept reminder. */
export const FRESH_LOCATION_MS = 10 * 60_000;

export interface DriverLocationPoint {
  telegramUserId: number;
  driverName: string;
  lat: number;
  lon: number;
  /** Telegram time of the fix (edit_date for live updates, else date), ms epoch. */
  at: number;
  livePeriod: number | null;
  heading: number | null;
  horizontalAccuracy: number | null;
  isLive: boolean;
  chatId: string | null;
}

export type ArrivalStatus = "pending" | "arrived" | "not_arrived" | "no_location";

export interface AcceptedCallRecord {
  eventId: number;
  telegramUserId: number | null;
  driverName: string;
  address: string | null;
  lat: number | null;
  lng: number | null;
  acceptedAt: number;
  status: ArrivalStatus;
  arrivedAt?: number | null;
  closestM?: number | null;
}

export function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Extract a location point from a Telegram update (message.location or
 * edited_message.location — the latter is how Live Location streams). Returns
 * null for anything else.
 */
export function parseLocationUpdate(update: any): DriverLocationPoint | null {
  const msg = update?.edited_message?.location ? update.edited_message : update?.message?.location ? update.message : null;
  if (!msg) return null;
  const loc = msg.location;
  const lat = num(loc?.latitude);
  const lon = num(loc?.longitude);
  const uid = num(msg.from?.id);
  if (lat == null || lon == null || uid == null) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const tSec = num(msg.edit_date) ?? num(msg.date);
  const from = msg.from ?? {};
  const name = from.username ? `@${from.username}` : [from.first_name, from.last_name].filter(Boolean).join(" ") || `User ${uid}`;
  const livePeriod = num(loc.live_period);
  return {
    telegramUserId: uid,
    driverName: name,
    lat,
    lon,
    at: tSec != null ? tSec * 1000 : Date.now(),
    livePeriod,
    heading: num(loc.heading),
    horizontalAccuracy: num(loc.horizontal_accuracy),
    isLive: livePeriod != null,
    chatId: msg.chat?.id != null ? String(msg.chat.id) : null,
  };
}

/** True when the message text is a /startshift (or /gps) command, incl. /startshift@BotName. */
export function isStartShiftCommand(text: unknown): boolean {
  if (typeof text !== "string") return false;
  const cmd = text.trim().split(/\s+/)[0].toLowerCase().split("@")[0];
  return cmd === "/startshift" || cmd === "/gps";
}

export const START_SHIFT_INSTRUCTIONS = [
  "📍 Start of shift — share your Live Location so accepted calls can be verified:",
  "1. Tap the 📎 (attach) button in this chat.",
  "2. Choose Location → Share My Live Location.",
  "3. Pick \"Until I turn it off\" (Telegram has no 12-hour option — 15 min, 1 h and 8 h all run out mid-shift).",
  "4. Keep it on all shift; stop sharing when you clock out.",
  "Tip: allow Telegram location access \"Always\" so it keeps updating with the screen off.",
].join("\n");

/** Most recent fix is fresh enough to count (and the live share hasn't expired). */
export function isLocationFresh(last: Pick<DriverLocationPoint, "at"> | null | undefined, now: number, maxAgeMs = FRESH_LOCATION_MS): boolean {
  if (!last) return false;
  return now - last.at <= maxAgeMs;
}

export function reminderText(driverName: string, eventId: number): string {
  return `⚠️ ${driverName}: you accepted call #${eventId} but I have no recent Live Location from you. Send /startshift for how to turn it on (choose "Until I turn it off").`;
}

/**
 * Decide the arrival status for an accepted call given that driver's location
 * points (any order). Points outside [acceptedAt, acceptedAt+window] are ignored.
 */
export function evaluateArrival(
  call: Pick<AcceptedCallRecord, "lat" | "lng" | "acceptedAt" | "telegramUserId">,
  points: Array<Pick<DriverLocationPoint, "lat" | "lon" | "at">>,
  now: number,
  opts: { radiusM?: number; windowMs?: number } = {},
): { status: ArrivalStatus; arrivedAt: number | null; closestM: number | null } {
  const radius = opts.radiusM ?? ARRIVAL_RADIUS_M;
  const windowMs = opts.windowMs ?? ARRIVAL_WINDOW_MS;
  const end = call.acceptedAt + windowMs;
  const inWindow = points.filter((p) => p.at >= call.acceptedAt && p.at <= end).sort((a, b) => a.at - b.at);
  const windowOver = now > end;
  if (call.lat == null || call.lng == null || call.telegramUserId == null) {
    // Can't verify without call coordinates / driver id.
    return { status: inWindow.length === 0 && windowOver ? "no_location" : windowOver ? "not_arrived" : "pending", arrivedAt: null, closestM: null };
  }
  let closest: number | null = null;
  for (const p of inWindow) {
    const d = haversineMeters(call.lat, call.lng, p.lat, p.lon);
    if (closest == null || d < closest) closest = d;
    if (d <= radius) return { status: "arrived", arrivedAt: p.at, closestM: Math.round(d) };
  }
  const closestM = closest == null ? null : Math.round(closest);
  if (!windowOver) return { status: "pending", arrivedAt: null, closestM };
  return { status: inWindow.length === 0 ? "no_location" : "not_arrived", arrivedAt: null, closestM };
}

export function formatAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, "0")}m`;
}
