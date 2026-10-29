/**
 * Tests for driver auto/manual removal helpers.
 * Run: npx tsx trial/test-driver-removal.ts
 */
import {
  readRemovalConfig, decideAutoRemoval, exemptionFor, isMissingBanRights, parseRemoveCommand,
  kickMember, removeReplyText, removalNoteText, type TgApi,
} from "../server/driver-removal-helpers";
import { parseAdminIds, isWhereAllowed } from "../server/telegram-where-helpers";

let fail = 0;
function check(label: string, got: unknown, want: unknown) {
  const ok = Object.is(got, want) || JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fail++; console.log("FAIL:", label, "| got:", got, "| want:", want); } else console.log("ok  :", label);
}

// Config
check("default off", readRemovalConfig({}).autoRemove, false);
check("needs gate too", readRemovalConfig({ DRIVER_AUTO_REMOVE: "1" }).autoRemove, false);
check("both on", readRemovalConfig({ DRIVER_AUTO_REMOVE: "1", DRIVER_LOCATION_GATE: "1" }).autoRemove, true);
check("grace default 30m", readRemovalConfig({}).shareGraceMs, 1_800_000);
check("deadline default 30m", readRemovalConfig({}).checkinDeadlineMs, 1_800_000);
check("grace custom", readRemovalConfig({ DRIVER_SHARE_GRACE_MIN: "45" }).shareGraceMs, 2_700_000);

// Grace timers
const cfg = readRemovalConfig({ DRIVER_AUTO_REMOVE: "1", DRIVER_LOCATION_GATE: "1" });
const T = 1_000_000_000_000, M = 60_000, F = 10 * M;
const d = (o: Partial<Parameters<typeof decideAutoRemoval>[0]>) =>
  decideAutoRemoval({ checkinAt: null, lastLiveFixAt: null, postedAt: null, now: T, freshMs: F, cfg, ...o });
check("checked in 29m ago, no share → wait", d({ checkinAt: T - 29 * M }), null);
check("checked in 30m ago, no share → remove", d({ checkinAt: T - 30 * M }), "no_share");
check("shared after check-in → keep", d({ checkinAt: T - 40 * M, lastLiveFixAt: T - 35 * M }), null);
check("already sharing just before check-in → keep", d({ checkinAt: T - 40 * M, lastLiveFixAt: T - 45 * M }), null);
check("old share from yesterday → remove", d({ checkinAt: T - 40 * M, lastLiveFixAt: T - 20 * 3600_000 }), "no_share");
check("seen, no check-in, post 29m ago → wait", d({ postedAt: T - 29 * M }), null);
check("seen, no check-in, post 30m ago → remove", d({ postedAt: T - 30 * M }), "no_checkin");
check("no post today → never no_checkin", d({}), null);

// Exemptions
const admins = parseAdminIds("8218273374 8270496557");
check("admin id exempt", exemptionFor(8218273374, { status: "member" }, admins), "admin_id");
check("creator exempt", exemptionFor(5, { status: "creator" }, admins), "chat_admin");
check("administrator exempt", exemptionFor(5, { status: "administrator" }, admins), "chat_admin");
check("bot exempt", exemptionFor(5, { status: "member", user: { is_bot: true } }, admins), "bot");
check("left skipped", exemptionFor(5, { status: "left" }, admins), "not_member");
check("member not exempt", exemptionFor(5, { status: "member" }, admins), null);

// Missing permissions
check("rights text", isMissingBanRights("Bad Request: not enough rights to restrict/unrestrict chat member"), true);
check("admin required", isMissingBanRights("Bad Request: need administrator rights in the chat"), true);
check("other error", isMissingBanRights("Bad Request: user not found"), false);

function fakeApi(responses: Record<string, any>): { api: TgApi; calls: string[] } {
  const calls: string[] = [];
  return { calls, api: async (m) => { calls.push(m); return responses[m] ?? { ok: true }; } };
}
(async () => {
  let f = fakeApi({ getChatMember: { ok: true, result: { status: "member", user: { id: 5 } } } });
  check("kick ok", await kickMember(f.api, -1, 5, admins), { ok: true });
  check("kick = ban then unban", f.calls, ["getChatMember", "banChatMember", "unbanChatMember"]);

  f = fakeApi({ getChatMember: { ok: true, result: { status: "administrator", user: { id: 5 } } } });
  check("kick admin refused", await kickMember(f.api, -1, 5, admins), { ok: false, why: "exempt", exempt: "chat_admin" });
  check("no ban call for admin", f.calls.includes("banChatMember"), false);

  f = fakeApi({});
  check("admin id refused without API", (await kickMember(f.api, -1, 8270496557, admins) as any).exempt, "admin_id");
  check("no API calls for admin id", f.calls.length, 0);

  f = fakeApi({ getChatMember: { ok: true, result: { status: "member" } }, banChatMember: { ok: false, description: "Bad Request: not enough rights to restrict/unrestrict chat member" } });
  const nr = await kickMember(f.api, -1, 5, admins);
  check("missing rights graceful", nr.ok === false && (nr as any).why, "no_rights");
  check("no unban after failed ban", f.calls.includes("unbanChatMember"), false);
  check("rights reply mentions Ban users", removeReplyText("@x", nr).includes("Ban users"), true);

  const thrower: TgApi = async () => { throw new Error("network"); };
  check("throw → error, no crash", (await kickMember(thrower, -1, 5, admins) as any).why, "error");

  // /remove parsing + admin-only
  check("reply target", parseRemoveCommand("/remove", { from: { id: 9, username: "bob" } }), { kind: "reply", id: 9, name: "@bob" });
  check("username target", parseRemoveCommand("/remove@STGAPPBOT @Bob_1"), { kind: "username", username: "bob_1" });
  check("id target", parseRemoveCommand("/remove 12345"), { kind: "id", id: 12345 });
  check("no target → usage", parseRemoveCommand("/remove"), "usage");
  check("garbage → usage", parseRemoveCommand("/remove !!"), "usage");
  check("not remove", parseRemoveCommand("/removed"), null);
  check("/remove allowed Zach", isWhereAllowed(8218273374, admins), true);
  check("/remove allowed PJ", isWhereAllowed(8270496557, admins), true);
  check("/remove denied driver", isWhereAllowed(5, admins), false);
  check("/remove denied when no admin config", isWhereAllowed(8218273374, parseAdminIds("")), false);

  check("note", removalNoteText([{ name: "@a", id: 1, reason: "no_share" }]).includes("didn't share"), true);

  console.log(fail ? `\n${fail} FAILED` : "\nall passed");
  process.exit(fail ? 1 : 0);
})();
