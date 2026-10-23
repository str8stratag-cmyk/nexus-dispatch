/**
 * Tests for daily check-in + location eligibility gate helpers.
 * Run: npx tsx trial/test-driver-checkin.ts
 */
import {
  readCheckinConfig, parseHhMm, localClock, shouldPostDailyCheckin, parseCheckinCallbackData, checkinCallbackData,
  evaluateEligibility, liveShareEndsAt, shouldRemind, isCheckinsCommand, formatRoster, ineligibleAcceptText,
  expiryReminderHtml, LIVE_PERIOD_INDEFINITE, dailyCheckinMarkup,
} from "../server/driver-checkin-helpers";
import { parseLocationUpdate } from "../server/driver-location-helpers";

let fail = 0;
function check(label: string, got: unknown, want: unknown) {
  const ok = Object.is(got, want) || JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fail++; console.log("FAIL:", label, "| got:", got, "| want:", want); } else console.log("ok  :", label);
}

// Config
const def = readCheckinConfig({});
check("gate default off", def.enabled, false);
check("default 6:00", def.postMinuteOfDay, 360);
check("default tz", def.timeZone, "America/New_York");
check("default fresh 10m", def.freshMs, 600_000);
const cfg = readCheckinConfig({ DRIVER_LOCATION_GATE: "1", DRIVER_CHECKIN_TIME: "05:30", DRIVER_LOCATION_FRESH_MIN: "15", DRIVER_REMINDER_COOLDOWN_MIN: "30" });
check("gate on", cfg.enabled, true);
check("time parsed", cfg.postMinuteOfDay, 330);
check("fresh parsed", cfg.freshMs, 900_000);
check("cooldown parsed", cfg.reminderCooldownMs, 1_800_000);
check("bad fresh falls back", readCheckinConfig({ DRIVER_LOCATION_FRESH_MIN: "abc" }).freshMs, 600_000);
check("bad time", parseHhMm("25:00"), null);
check("time 6:00", parseHhMm("6:00"), 360);

// Clock (EDT = UTC-4 on 2026-10-23; EST = UTC-5 on 2026-12-01)
check("ny clock EDT", localClock(Date.parse("2026-10-23T10:00:00Z"), "America/New_York"), { date: "2026-10-23", minuteOfDay: 360 });
check("ny clock EST", localClock(Date.parse("2026-12-01T11:00:00Z"), "America/New_York"), { date: "2026-12-01", minuteOfDay: 360 });
check("ny date before midnight", localClock(Date.parse("2026-10-24T03:30:00Z"), "America/New_York").date, "2026-10-23");

// Daily post
const c6 = readCheckinConfig({ DRIVER_LOCATION_GATE: "1" });
check("before 6am no post", shouldPostDailyCheckin(Date.parse("2026-10-23T09:59:00Z"), null, c6), null);
check("6am post", shouldPostDailyCheckin(Date.parse("2026-10-23T10:00:30Z"), "2026-10-22", c6), "2026-10-23");
check("dup guard", shouldPostDailyCheckin(Date.parse("2026-10-23T10:05:00Z"), "2026-10-23", c6), null);
check("catch-up 9am", shouldPostDailyCheckin(Date.parse("2026-10-23T13:00:00Z"), "2026-10-22", c6), "2026-10-23");
check("no late post 3pm", shouldPostDailyCheckin(Date.parse("2026-10-23T19:00:00Z"), "2026-10-22", c6), null);

// Callback
check("cb roundtrip", parseCheckinCallbackData(checkinCallbackData("2026-10-23")), "2026-10-23");
check("cb accept not checkin", parseCheckinCallbackData("accept_12"), null);
check("cb markup", dailyCheckinMarkup("2026-10-23").inline_keyboard[0][0].callback_data, "checkin_2026-10-23");

// Eligibility
const now = 1_000_000_000_000;
const live = (agoMs: number, livePeriod: number | null, startedAgoMs = agoMs) =>
  ({ at: now - agoMs, livePeriod, isLive: livePeriod != null, liveStartedAt: now - startedAgoMs });
check("not checked in", evaluateEligibility(false, live(0, 3600), now, 600_000), "not_checked_in");
check("no location", evaluateEligibility(true, null, now, 600_000), "no_location");
check("static pin not live", evaluateEligibility(true, live(0, null), now, 600_000), "no_location");
check("fresh live", evaluateEligibility(true, live(60_000, 28800, 3600_000), now, 600_000), "eligible");
check("stale", evaluateEligibility(true, live(11 * 60_000, LIVE_PERIOD_INDEFINITE), now, 600_000), "stale");
check("expired 8h", evaluateEligibility(true, live(60_000, 28800, 9 * 3600_000), now, 600_000), "expired");
check("indefinite never expires", liveShareEndsAt({ at: 0, livePeriod: LIVE_PERIOD_INDEFINITE, liveStartedAt: 0 }), null);

// parseLocationUpdate carries liveStartedAt from original message date
const p = parseLocationUpdate({ edited_message: { date: 100, edit_date: 200, from: { id: 5, username: "d" }, chat: { id: -1 }, location: { latitude: 1, longitude: 2, live_period: 28800 } } });
check("liveStartedAt", p?.liveStartedAt, 100_000);
check("at from edit_date", p?.at, 200_000);

// Reminders
check("remind first lapse", shouldRemind("stale", 5, null, now, 3600_000), true);
check("no remind eligible", shouldRemind("eligible", 5, null, now, 3600_000), false);
check("no remind not checked in", shouldRemind("not_checked_in", 5, null, now, 3600_000), false);
check("once per lapse", shouldRemind("expired", 5, { lastAt: now - 9e9, forFixAt: 5 }, now, 3600_000), false);
check("new lapse within cooldown", shouldRemind("stale", 6, { lastAt: now - 60_000, forFixAt: 5 }, now, 3600_000), false);
check("new lapse after cooldown", shouldRemind("stale", 6, { lastAt: now - 3600_000, forFixAt: 5 }, now, 3600_000), true);
check("mention escapes", expiryReminderHtml(7, "<b>x", "stale").includes('tg://user?id=7">&lt;b&gt;x</a>'), true);

// Commands / text
check("/checkins", isCheckinsCommand("/checkins"), true);
check("/checkins@bot", isCheckinsCommand("/checkins@STGAPPBOT"), true);
check("/checkin no", isCheckinsCommand("/checkin"), false);
check("ineligible text", ineligibleAcceptText("not_checked_in", 10).includes("not checked in"), true);
const roster = formatRoster("2026-10-23", [
  { telegramUserId: 1, driverName: "@a", checkedIn: true, lastFixAt: now - 60_000, status: "eligible" },
  { telegramUserId: 2, driverName: "@b", checkedIn: true, lastFixAt: null, status: "no_location" },
  { telegramUserId: 3, driverName: "@c", checkedIn: false, lastFixAt: now, status: "not_checked_in" },
], now, true);
check("roster eligible", roster.includes("Eligible (1)"), true);
check("roster missing", roster.includes("not sharing (1)"), true);
check("roster not in", roster.includes("not checked in (1)"), true);

console.log(fail ? `\n${fail} FAILED` : "\nall passed");
process.exit(fail ? 1 : 0);
