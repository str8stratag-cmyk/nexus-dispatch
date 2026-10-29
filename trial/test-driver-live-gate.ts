/**
 * Live-location check-in + continuous membership gate.
 * Run: npx tsx trial/test-driver-live-gate.ts
 *
 * Covers check-in transitions, live/stop/static classification, join-grace
 * removal, warn-once then remove (stop / expiry / stale), busy-free resume,
 * and the exempt list. No nearest-driver routing: calls stay in the group.
 */
import { LIVE_PERIOD_INDEFINITE } from "../server/driver-checkin-helpers";
import {
  acceptsLocationChat,
  applyJoin,
  blankLiveState,
  checkinReplyText,
  classifyLocationUpdate,
  decideGateAction,
  effectiveLiveGateConfig,
  graceMinutes,
  isAlreadyParticipant,
  isPrivateChat,
  joinWelcomeText,
  locationStoppedNotice,
  locationStoppedWarning,
  parseJoinRequest,
  readLiveGateConfig,
  reduceLocation,
  removalNotice,
  shareHealth,
  telegramAllowedUpdates,
  type LiveGateConfig,
  type LiveGateState,
  type LocationFixInput,
} from "../server/driver-live-gate-helpers";

let fail = 0;
function check(label: string, got: unknown, want: unknown) {
  const ok = Object.is(got, want) || JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fail++; console.log("FAIL:", label, "| got:", got, "| want:", want); }
  else console.log("ok  :", label);
}

const MIN = 60_000;
const T = 1_700_000_000_000;
const INDEF = LIVE_PERIOD_INDEFINITE;

function cfg(extra: Record<string, string | undefined> = {}): LiveGateConfig {
  return readLiveGateConfig({ DRIVER_LIVE_GATE: "1", ...extra });
}

function st(p: Partial<LiveGateState> = {}): LiveGateState {
  return { ...blankLiveState(p.telegramUserId ?? 4, p.driverName ?? "Sam"), ...p };
}

function fix(at: number, over: Partial<LocationFixInput> = {}): LocationFixInput {
  return {
    userId: 4,
    driverName: "Sam",
    at,
    livePeriod: INDEF,
    liveStartedAt: at,
    lat: 27.95,
    lon: -82.46,
    liveChatId: "-100",
    liveMessageId: 10,
    ...over,
  };
}

// --- config (off unless DRIVER_LIVE_GATE is explicitly on) ---
const def = readLiveGateConfig({});
check("gate default off", def.enabled, false);
check("daily gate does not enable it", readLiveGateConfig({ DRIVER_LOCATION_GATE: "1", DRIVER_AUTO_REMOVE: "1" }).enabled, false);
check("explicit 0 off", readLiveGateConfig({ DRIVER_LIVE_GATE: "0" }).enabled, false);
check("default join 10m", def.joinGraceMs, 10 * MIN);
check("default stale 15m", def.staleMs, 15 * MIN);
check("default resume 5m", def.resumeGraceMs, 5 * MIN);
check("default exempt empty", def.exemptIds.size, 0);
const custom = cfg({
  DRIVER_LIVE_GATE: "yes",
  DRIVER_JOIN_GRACE_MIN: "12",
  DRIVER_LIVE_STALE_MIN: "20",
  DRIVER_RESUME_GRACE_MIN: "7",
  DRIVER_LIVE_EXEMPT_IDS: "12, 34",
});
check("gate on", custom.enabled, true);
check("join custom", custom.joinGraceMs, 12 * MIN);
check("stale custom", custom.staleMs, 20 * MIN);
check("resume custom", custom.resumeGraceMs, 7 * MIN);
check("exempt parsed", Array.from(custom.exemptIds).sort((a, b) => a - b), [12, 34]);
check("bad timing falls back", readLiveGateConfig({ DRIVER_JOIN_GRACE_MIN: "0", DRIVER_LIVE_STALE_MIN: "nope" }).staleMs, 15 * MIN);
check("grace minutes", graceMinutes(5 * MIN), 5);
check("grace minutes join", graceMinutes(10 * MIN), 10);

const C = cfg();
const eff = effectiveLiveGateConfig({ DRIVER_LIVE_GATE: "1", DRIVER_LIVE_EXEMPT_IDS: "8", TELEGRAM_ADMIN_IDS: "9" });
check("effective unions admins", Array.from(eff.exemptIds).sort((a, b) => a - b), [8, 9]);

// --- copy ---
check("check-in reply", checkinReplyText("Sam"), "✅ Sam checked in — receiving calls.");
check("warning sentence", locationStoppedWarning(5), "Your location stopped — re-share within 5 min or you'll be removed");
check("warning names the driver", locationStoppedNotice("Sam", 5).includes(locationStoppedWarning(5)), true);
check("welcome threatens removal", joinWelcomeText("Sam", 10, false).includes("within 10 min or you'll be removed"), true);
check("exempt welcome does not threaten", joinWelcomeText("Sam", 10, true).includes("you'll be removed"), false);
check("removal no-share", removalNotice("Sam", 4, "no_share").includes("didn't share Live Location"), true);
check("removal stopped", removalNotice("Sam", 4, "stale").includes("was not re-shared"), true);

// --- classification ---
check("live message", classifyLocationUpdate({ message: { location: { latitude: 1, longitude: 2, live_period: 3600 } } }), "live");
check("live edit", classifyLocationUpdate({ edited_message: { location: { latitude: 1, longitude: 2, live_period: 60 } } }), "live");
check("explicit stop", classifyLocationUpdate({ edited_message: { location: { latitude: 1, longitude: 2 } } }), "stop");
check("static pin", classifyLocationUpdate({ message: { location: { latitude: 1, longitude: 2 } } }), "static");
check("not a location", classifyLocationUpdate({ message: { text: "hi" } }), null);
check("private edited", isPrivateChat({ edited_message: { chat: { type: "private" } } }), true);
check("group not private", isPrivateChat({ message: { chat: { type: "supergroup" } } }), false);

const privLive = { message: { chat: { id: 5, type: "private" }, location: { live_period: 60 } } };
const privStatic = { message: { chat: { id: 5, type: "private" }, location: {} } };
const privStop = { edited_message: { chat: { id: 5, type: "private" }, location: { latitude: 1 } } };
check("group stored even if gate off", acceptsLocationChat("-100", privLive, "-100", false), true);
check("private live dropped when gate off", acceptsLocationChat("5", privLive, "-100", false), false);
check("private live kept when gate on", acceptsLocationChat("5", privLive, "-100", true), true);
check("private static dropped", acceptsLocationChat("5", privStatic, "-100", true), false);
check("private stop kept", acceptsLocationChat("5", privStop, "-100", true), true);
check("other group dropped", acceptsLocationChat("-200", { message: { chat: { type: "supergroup" } } }, "-100", true), false);
check("supergroup id trims", acceptsLocationChat(" -100 ", privLive, "-100", false), true);

check("updates unchanged when off", telegramAllowedUpdates(false), ["callback_query", "message", "edited_message"]);
check("join requests only when on", telegramAllowedUpdates(true).includes("chat_join_request"), true);
check("accept types kept", telegramAllowedUpdates(true).slice(0, 3), ["callback_query", "message", "edited_message"]);

const jr = parseJoinRequest({
  chat_join_request: { chat: { id: -100, type: "supergroup" }, from: { id: 7, username: "Bob", is_bot: false } },
});
check("join parse", jr, { chatId: "-100", userId: 7, name: "@Bob", username: "Bob", isBot: false });
check("join missing", parseJoinRequest({ message: {} }), null);
check("already participant", isAlreadyParticipant("Bad Request: USER_ALREADY_PARTICIPANT"), true);
check("other error", isAlreadyParticipant("not enough rights"), false);

// --- check-in transitions ---
const first = reduceLocation(null, "live", fix(T), T, C.staleMs);
check("first share announces", first?.announce, true);
check("first share checked in", first?.state.checkedIn, true);
check("first share live", first?.state.isLive, true);
check("first share gen", first?.state.shareGen, 1);
check("reply would be", checkinReplyText(first!.state.driverName), "✅ Sam checked in — receiving calls.");

const tick = reduceLocation(first!.state, "live", fix(T + 1000, { liveStartedAt: T }), T + 1000, C.staleMs);
check("gps tick silent", tick?.announce, false);
check("gps tick same gen", tick?.state.shareGen, 1);
check("active driver stays", decideGateAction(tick!.state, T + 1000, C), { action: "none" });

check("static ignored", reduceLocation(tick!.state, "static", fix(T + 2000, { livePeriod: null }), T + 2000, C.staleMs), null);
check("stop without history ignored", reduceLocation(null, "stop", fix(T, { livePeriod: null }), T, C.staleMs), null);

const stopped = reduceLocation(tick!.state, "stop", fix(T + 5000, { livePeriod: null, liveStartedAt: null }), T + 5000, C.staleMs);
check("stop does not re-announce", stopped?.announce, false);
check("stop keeps gen", stopped?.state.shareGen, 1);
check("stop keeps warn clock clear", stopped?.state.warnedAt, null);
check("stop is not live", stopped?.state.isLive, false);
check("health stopped", shareHealth(stopped!.state, T + 5000, C.staleMs), "stopped");
check("stop warns once", decideGateAction(stopped!.state, T + 5000, C), { action: "warn", reason: "stopped" });

const warned = { ...stopped!.state, warnedAt: T + 5000 };
check("no second warning inside grace", decideGateAction(warned, T + 5000 + 4 * MIN, C), { action: "none" });
check("remove when resume grace ends", decideGateAction(warned, T + 5000 + 5 * MIN, C), { action: "remove", reason: "stopped" });
check("still inside at 5m-1ms", decideGateAction(warned, T + 5000 + 5 * MIN - 1, C), { action: "none" });

const resumed = reduceLocation(stopped!.state, "live", fix(T + 5000 + 4 * MIN), T + 5000 + 4 * MIN, C.staleMs);
check("resume announces", resumed?.announce, true);
check("resume clears warning", resumed?.state.warnedAt, null);
check("resume bumps gen", resumed?.state.shareGen, 2);
check("resume is active", resumed?.state.isLive, true);
check("resumed driver is not removed at the old deadline", decideGateAction(resumed!.state, T + 5000 + 5 * MIN, C), { action: "none" });

// A second stop after resume warns again (new lapse), then the new 5 min clock.
const stoppedAgain = reduceLocation(resumed!.state, "stop", fix(T + 5000 + 6 * MIN, { livePeriod: null }), T + 5000 + 6 * MIN, C.staleMs);
check("second lapse warns", decideGateAction(stoppedAgain!.state, T + 5000 + 6 * MIN, C), { action: "warn", reason: "stopped" });
check("second lapse new gen", stoppedAgain?.state.shareGen, 2);

// --- expiry and stale ---
const fresh = first!.state;
const expired = { ...fresh, livePeriod: 60, liveStartedAt: T - 60_000, lastFixAt: T - 1000, isLive: true, stoppedAt: null, warnedAt: null };
check("health expired", shareHealth(expired, T, C.staleMs), "expired");
check("expiry warns", decideGateAction(expired, T, C), { action: "warn", reason: "expired" });
const expiredWarned = { ...expired, warnedAt: T };
check("expiry remove after grace", decideGateAction(expiredWarned, T + 5 * MIN, C), { action: "remove", reason: "expired" });
check("indefinite is not expired", shareHealth(fresh, T + MIN, C.staleMs), "active");

const lateEdit = reduceLocation(fresh, "live", fix(T, { livePeriod: 60, liveStartedAt: T - 120_000 }), T, C.staleMs);
check("already-expired edit is not a check-in", lateEdit?.announce, false);
check("already-expired edit ends the share", lateEdit?.state.isLive, false);
check("already-expired edit keeps gen", lateEdit?.state.shareGen, fresh.shareGen);

const stale = { ...fresh, lastFixAt: T - C.staleMs - 1 };
check("health stale just over", shareHealth(stale, T, C.staleMs), "stale");
check("stale warns", decideGateAction(stale, T, C), { action: "warn", reason: "stale" });
check("exact stale window still active", shareHealth({ ...fresh, lastFixAt: T - C.staleMs }, T, C.staleMs), "active");
const staleWarned = { ...stale, warnedAt: T };
check("stale no double warn", decideGateAction(staleWarned, T + MIN, C), { action: "none" });
check("stale remove", decideGateAction(staleWarned, T + 5 * MIN, C), { action: "remove", reason: "stale" });

// Resume before the stale removal sticks.
const back = reduceLocation(stale, "live", fix(T), T, C.staleMs);
check("stale resume announces", back?.announce, true);
check("stale resume not removed", decideGateAction(back!.state, T + 10 * MIN, C).action, "none");

// --- join grace ---
const joined = applyJoin(null, 8, "@new", T, C);
check("join welcomes", joined.welcome, true);
check("join not checked in", joined.state.checkedIn, false);
check("join clock starts at approval", joined.state.joinedAt, T);
check("inside 10 min", decideGateAction(joined.state, T + 10 * MIN - 1, C), { action: "none" });
check("at 10 min remove without a warning", decideGateAction(joined.state, T + 10 * MIN, C), { action: "remove", reason: "no_share" });
check("existing member with no join is not mass-removed", decideGateAction(blankLiveState(3, "Pat"), T + 24 * 60 * MIN, C), { action: "none" });

const joinedThenShared = reduceLocation(joined.state, "live", fix(T + 5 * MIN, { userId: 8, driverName: "@new" }), T + 5 * MIN, C.staleMs);
check("share inside grace checks in", joinedThenShared?.announce, true);
check("share inside grace cancels removal", decideGateAction(joinedThenShared!.state, T + 10 * MIN, C), { action: "none" });

const pendingStop = reduceLocation(joined.state, "stop", fix(T + MIN, { livePeriod: null }), T + MIN, C.staleMs);
check("stop before check-in is still the join clock", decideGateAction(pendingStop!.state, T + MIN, C), { action: "none" });
check("stop before check-in still removes at 10 min", decideGateAction(pendingStop!.state, T + 10 * MIN, C), { action: "remove", reason: "no_share" });

const rejoin = applyJoin(fresh, 4, "Sam", T + MIN, C);
check("active sharer is not reset by another join", rejoin.welcome, false);
check("active sharer stays checked in", rejoin.state.checkedIn, true);

// --- exemptions, hold, already removed, flag off ---
const lateJoiner = { ...joined.state, telegramUserId: 8 };
check("exempt id not removed", decideGateAction(lateJoiner, T + 999 * MIN, eff), { action: "none" });
check("admin id not removed", decideGateAction({ ...joined.state, telegramUserId: 9 }, T + 999 * MIN, eff), { action: "none" });
check("other id still removed", decideGateAction({ ...joined.state, telegramUserId: 10 }, T + 10 * MIN, eff), { action: "remove", reason: "no_share" });
check("exempt stopped driver not warned", decideGateAction({ ...stopped!.state, telegramUserId: 8 }, T, eff), { action: "none" });
check("hold skips", decideGateAction({ ...joined.state, hold: "exempt" }, T + 999 * MIN, C), { action: "none" });
check("already removed skips", decideGateAction({ ...joined.state, removedAt: T }, T + 999 * MIN, C), { action: "none" });
check("flag off skips", decideGateAction(joined.state, T + 999 * MIN, readLiveGateConfig({})), { action: "none" });

console.log(fail ? `\n${fail} FAILED` : "\nall passed");
process.exit(fail ? 1 : 0);
