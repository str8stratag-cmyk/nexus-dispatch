/**
 * Pure-helper tests for driver Live Location + arrival verification.
 * Run: npx tsx trial/test-driver-location.ts
 */
import {
  haversineMeters, parseLocationUpdate, isStartShiftCommand, evaluateArrival,
  isLocationFresh, formatAge, isDispatchGroupChat, driverFreshness, reminderText, START_SHIFT_INSTRUCTIONS,
} from "../server/driver-location-helpers";

let fail = 0;
function check(label: string, got: unknown, want: unknown) {
  const ok = Object.is(got, want) || JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fail++; console.log("FAIL:", label, "| got:", got, "| want:", want); } else console.log("ok  :", label);
}

// ~111 m per 0.001 deg lat
const d = haversineMeters(40.0, -75.0, 40.001, -75.0);
check("haversine ~111m", Math.round(d), 111);
check("haversine zero", haversineMeters(1, 2, 1, 2), 0);

const live = parseLocationUpdate({ update_id: 5, edited_message: { message_id: 9, date: 1000, edit_date: 1060,
  chat: { id: -100 }, from: { id: 77, first_name: "Bob", last_name: "T" },
  location: { latitude: 40, longitude: -75, live_period: 2147483647, heading: 90 } } });
check("live user", live?.telegramUserId, 77);
check("live name", live?.driverName, "Bob T");
check("live uses edit_date", live?.at, 1_060_000);
check("live flag", live?.isLive, true);
check("live heading", live?.heading, 90);
check("live chat", live?.chatId, "-100");
const stat = parseLocationUpdate({ message: { date: 5, from: { id: 1, username: "drv" }, chat: { id: 1 }, location: { latitude: 1, longitude: 2 } } });
check("static not live", stat?.isLive, false);
check("static username", stat?.driverName, "@drv");
check("static livePeriod null", stat?.livePeriod, null);
check("no location", parseLocationUpdate({ message: { text: "hi", from: { id: 1 } } }), null);
check("callback ignored", parseLocationUpdate({ callback_query: { data: "accept_1" } }), null);
check("bad coords", parseLocationUpdate({ message: { date: 1, from: { id: 1 }, location: { latitude: 200, longitude: 0 } } }), null);
check("no from", parseLocationUpdate({ message: { date: 1, location: { latitude: 1, longitude: 0 } } }), null);

check("cmd startshift", isStartShiftCommand("/startshift"), true);
check("cmd @bot", isStartShiftCommand("/StartShift@TowBot now"), true);
check("cmd gps", isStartShiftCommand("/gps"), true);
check("cmd other", isStartShiftCommand("/start"), false);
check("cmd non-string", isStartShiftCommand(undefined), false);
check("instructions mention until off", /Until I turn it off/.test(START_SHIFT_INSTRUCTIONS), true);
check("reminder", reminderText("@drv", 12).includes("#12"), true);

const now = 10_000_000;
check("fresh", isLocationFresh({ at: now - 60_000 }, now), true);
check("stale", isLocationFresh({ at: now - 11 * 60_000 }, now), false);
check("none", isLocationFresh(null, now), false);

const call = { lat: 40.0, lng: -75.0, acceptedAt: 0, telegramUserId: 77 };
const far = { lat: 40.01, lon: -75.0 }; // ~1.1 km
const near = { lat: 40.0015, lon: -75.0 }; // ~167 m
check("arrived", evaluateArrival(call, [{ ...far, at: 60_000 }, { ...near, at: 600_000 }], 700_000).status, "arrived");
check("arrivedAt", evaluateArrival(call, [{ ...near, at: 600_000 }], 700_000).arrivedAt, 600_000);
check("pending in window", evaluateArrival(call, [{ ...far, at: 60_000 }], 30 * 60_000).status, "pending");
check("not arrived after window", evaluateArrival(call, [{ ...far, at: 60_000 }], 61 * 60_000).status, "not_arrived");
check("closest reported", evaluateArrival(call, [{ ...far, at: 60_000 }], 61 * 60_000).closestM, 1112);
check("no location", evaluateArrival(call, [], 61 * 60_000).status, "no_location");
check("pre-accept fix ignored", evaluateArrival(call, [{ ...near, at: -1000 }], 61 * 60_000).status, "no_location");
check("late arrival ignored", evaluateArrival(call, [{ ...near, at: 61 * 60_000 }], 62 * 60_000).status, "no_location");
check("no call coords", evaluateArrival({ ...call, lat: null }, [{ ...near, at: 1 }], 61 * 60_000).status, "not_arrived");
check("no driver id", evaluateArrival({ ...call, telegramUserId: null }, [], 61 * 60_000).status, "no_location");

check("age s", formatAge(42_000), "42s");
check("age m", formatAge(5 * 60_000), "5m");
check("age h", formatAge(125 * 60_000), "2h05m");

check("group match", isDispatchGroupChat("-100123", "-100123"), true);
check("group match trims", isDispatchGroupChat("-100123", " -100123 "), true);
check("other chat dropped", isDispatchGroupChat("555", "-100123"), false);
check("private chat dropped", isDispatchGroupChat("77", "-100123"), false);
check("no config drops", isDispatchGroupChat("-100123", undefined), false);
check("no chat drops", isDispatchGroupChat(null, "-100123"), false);
check("empty config drops", isDispatchGroupChat("", ""), false);
check("fresh bucket", driverFreshness(5 * 60_000), "fresh");
check("stale bucket", driverFreshness(30 * 60_000), "stale");
check("offline bucket", driverFreshness(2 * 3600_000), "offline");

console.log(fail ? `\n${fail} FAILED` : "\nall passed");
process.exit(fail ? 1 : 0);
