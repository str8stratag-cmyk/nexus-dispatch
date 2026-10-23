/**
 * Pure helpers for the daily driver check-in + location eligibility gate.
 * Owner rule: drivers who are not sharing Live Location do NOT get calls.
 * Free of Express/Mongo so trial tests can import directly.
 */
import { formatAge, type DriverLocationPoint } from "./driver-location-helpers";

/** Telegram's live_period for "Until I turn it off". */
export const LIVE_PERIOD_INDEFINITE = 0x7fffffff;

export interface CheckinConfig {
  enabled: boolean;
  /** Minutes after local midnight to post the daily check-in (default 06:00). */
  postMinuteOfDay: number;
  timeZone: string;
  /** Last fix must be at most this old to count as "sharing". */
  freshMs: number;
  /** Minimum gap between expiry reminders to the same driver. */
  reminderCooldownMs: number;
  /** Don't post a missed check-in later than this many minutes after the target (desk was down). */
  catchUpWindowMin: number;
}

function truthy(v: string | undefined): boolean {
  const s = (v || "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

function posNum(v: string | undefined, dflt: number): number {
  const n = Number((v ?? "").trim());
  return v != null && v.trim() !== "" && Number.isFinite(n) && n > 0 ? n : dflt;
}

/** Parse "6:00" / "06:30" → minutes of day; null if invalid. */
export function parseHhMm(v: string | undefined): number | null {
  const m = String(v ?? "").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

export function readCheckinConfig(env: Record<string, string | undefined> = process.env): CheckinConfig {
  return {
    enabled: truthy(env.DRIVER_LOCATION_GATE),
    postMinuteOfDay: parseHhMm(env.DRIVER_CHECKIN_TIME) ?? 6 * 60,
    timeZone: (env.DRIVER_CHECKIN_TZ || "").trim() || "America/New_York",
    freshMs: posNum(env.DRIVER_LOCATION_FRESH_MIN, 10) * 60_000,
    reminderCooldownMs: posNum(env.DRIVER_REMINDER_COOLDOWN_MIN, 60) * 60_000,
    catchUpWindowMin: posNum(env.DRIVER_CHECKIN_CATCHUP_MIN, 240),
  };
}

/** Local calendar date (YYYY-MM-DD) and minute-of-day in `timeZone`. */
export function localClock(now: number, timeZone: string): { date: string; minuteOfDay: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(now));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, minuteOfDay: Number(get("hour")) * 60 + Number(get("minute")) };
}

/** Post today's check-in iff it's at/after the target time (within catch-up window) and not already sent today. */
export function shouldPostDailyCheckin(now: number, lastSentDate: string | null | undefined, cfg: CheckinConfig): string | null {
  const { date, minuteOfDay } = localClock(now, cfg.timeZone);
  if (lastSentDate === date) return null;
  if (minuteOfDay < cfg.postMinuteOfDay || minuteOfDay > cfg.postMinuteOfDay + cfg.catchUpWindowMin) return null;
  return date;
}

export function checkinCallbackData(date: string): string {
  return `checkin_${date}`;
}

/** "checkin_2026-10-23" → "2026-10-23"; null otherwise. */
export function parseCheckinCallbackData(data: unknown): string | null {
  if (typeof data !== "string") return null;
  const m = data.match(/^checkin_(\d{4}-\d{2}-\d{2})$/);
  return m ? m[1] : null;
}

export function dailyCheckinText(date: string, freshMin: number): string {
  return [
    `🌅 Check in for today (${date})`,
    "",
    "Drivers: tap ✅ Check in below, then share your Live Location in this group:",
    "1. Tap 📎 (attach) → Location → Share My Live Location.",
    "2. Choose \"Until I turn it off\" (or 8 hours).",
    "3. Keep it on all shift — allow Telegram location access \"Always\".",
    "",
    `⚠️ No check-in or no live location (updated in the last ${freshMin} min) = no calls.`,
  ].join("\n");
}

export function dailyCheckinMarkup(date: string) {
  return { inline_keyboard: [[{ text: "✅ Check in for today", callback_data: checkinCallbackData(date) }]] };
}

export type Eligibility = "eligible" | "not_checked_in" | "no_location" | "stale" | "expired";

/** When the live share ends (ms epoch), or null if indefinite / not a live share. */
export function liveShareEndsAt(last: Pick<DriverLocationPoint, "livePeriod" | "at"> & { liveStartedAt?: number | null }): number | null {
  if (last.livePeriod == null || last.livePeriod >= LIVE_PERIOD_INDEFINITE) return null;
  const start = last.liveStartedAt ?? last.at;
  return start + last.livePeriod * 1000;
}

export function evaluateEligibility(
  checkedInToday: boolean,
  last: (Pick<DriverLocationPoint, "at" | "livePeriod" | "isLive"> & { liveStartedAt?: number | null }) | null | undefined,
  now: number,
  freshMs: number,
): Eligibility {
  if (!checkedInToday) return "not_checked_in";
  if (!last || !last.isLive) return "no_location";
  const ends = liveShareEndsAt(last);
  if (ends != null && now > ends) return "expired";
  if (now - last.at > freshMs) return "stale";
  return "eligible";
}

export function ineligibleAcceptText(reason: Eligibility, freshMin: number): string {
  switch (reason) {
    case "not_checked_in":
      return "You're not checked in today. Tap ✅ Check in on today's check-in message and share your Live Location to get calls.";
    case "no_location":
      return "No Live Location from you. Share Live Location in the group (📎 → Location → Live, \"Until I turn it off\") to get calls.";
    case "expired":
      return "Your Live Location share has ended. Share it again (\"Until I turn it off\") to get calls.";
    case "stale":
      return `Your Live Location hasn't updated in over ${freshMin} min. Open Telegram / re-share Live Location to get calls.`;
    default:
      return "";
  }
}

/** Reply to a ✅ Check in tap (callback toast). */
export function checkinAckText(alreadyIn: boolean, sharing: boolean): string {
  const head = alreadyIn ? "You're already checked in today." : "Checked in for today ✅";
  return sharing ? `${head} Live Location is on — you're eligible for calls.` : `${head} Now share your Live Location in the group or you won't get calls.`;
}

/**
 * Remind once per lapse: driver is checked in today, their share is expired/stale,
 * we haven't already reminded for this same last fix, and the cooldown has passed.
 */
export function shouldRemind(
  status: Eligibility,
  lastFixAt: number | null,
  reminder: { lastAt: number; forFixAt: number | null } | null | undefined,
  now: number,
  cooldownMs: number,
): boolean {
  if (status !== "stale" && status !== "expired") return false;
  if (!reminder) return true;
  if (reminder.forFixAt === lastFixAt) return false;
  return now - reminder.lastAt >= cooldownMs;
}

export function reminderMention(telegramUserId: number, driverName: string): string {
  const esc = driverName.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<a href="tg://user?id=${telegramUserId}">${esc}</a>`;
}

export function expiryReminderHtml(telegramUserId: number, driverName: string, status: Eligibility): string {
  const why = status === "expired" ? "your Live Location share ended" : "your Live Location stopped updating";
  return `📍 ${reminderMention(telegramUserId, driverName)} — ${why}. You won't get calls until you share it again (📎 → Location → Share My Live Location → "Until I turn it off").`;
}

/** Parse "/checkins" or "/checkins@Bot". */
export function isCheckinsCommand(text: unknown): boolean {
  if (typeof text !== "string") return false;
  return /^\/checkins(?:@\w+)?$/i.test(text.trim());
}

export interface RosterRow {
  telegramUserId: number;
  driverName: string;
  checkedIn: boolean;
  lastFixAt: number | null;
  status: Eligibility;
}

const LABEL: Record<Eligibility, string> = {
  eligible: "🟢 sharing",
  not_checked_in: "⚪ not checked in",
  no_location: "🔴 no live location",
  stale: "🟠 stale",
  expired: "🔴 share ended",
};

export function formatRoster(date: string, rows: RosterRow[], now: number, gateOn: boolean): string {
  const line = (r: RosterRow) =>
    `• ${r.driverName} — ${LABEL[r.status]}${r.lastFixAt != null ? ` (last fix ${formatAge(now - r.lastFixAt)} ago)` : ""}`;
  const ok = rows.filter((r) => r.status === "eligible");
  const missing = rows.filter((r) => r.checkedIn && r.status !== "eligible");
  const notIn = rows.filter((r) => !r.checkedIn);
  const out = [`📋 Check-ins ${date}${gateOn ? "" : " (gate OFF — calls not restricted)"}`];
  out.push("", `✅ Eligible (${ok.length}):`, ...(ok.length ? ok.map(line) : ["  none"]));
  out.push("", `⚠️ Checked in, not sharing (${missing.length}):`, ...(missing.length ? missing.map(line) : ["  none"]));
  if (notIn.length) out.push("", `⚪ Seen but not checked in (${notIn.length}):`, ...notIn.map(line));
  return out.join("\n");
}
