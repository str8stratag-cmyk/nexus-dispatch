/**
 * Tests for the admin-only /where command helpers.
 * Run: npx tsx trial/test-telegram-where.ts
 */
import {
  parseWhereCommand, parseAdminIds, isWhereAllowed, isWhereChatAllowed,
  filterDrivers, mapsLink, formatWhereLine, formatWhereReply,
} from "../server/telegram-where-helpers";

let fail = 0;
function check(label: string, got: unknown, want: unknown) {
  const ok = Object.is(got, want) || JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fail++; console.log("FAIL:", label, "| got:", got, "| want:", want); } else console.log("ok  :", label);
}

check("bare", parseWhereCommand("/where"), { query: "" });
check("with name", parseWhereCommand("/where Bob"), { query: "Bob" });
check("bot suffix", parseWhereCommand("/where@TowBot  @bob "), { query: "@bob" });
check("case", parseWhereCommand("/WHERE"), { query: "" });
check("not prefix-word", parseWhereCommand("/whereabouts"), null);
check("other cmd", parseWhereCommand("/startshift"), null);
check("non-string", parseWhereCommand(undefined), null);

const admins = parseAdminIds(" 111, 222 333;abc,-5 ");
check("admin ids", [...admins], [111, 222, 333]);
check("empty env", parseAdminIds(undefined).size, 0);
check("allowed", isWhereAllowed(222, admins), true);
check("denied", isWhereAllowed(999, admins), false);
check("denied string id", isWhereAllowed("222", admins), false);
check("denied when no config", isWhereAllowed(111, parseAdminIds("")), false);

check("private ok", isWhereChatAllowed({ id: 111, type: "private" }, "-100"), true);
check("dispatch group ok", isWhereChatAllowed({ id: -100, type: "supergroup" }, "-100"), true);
check("other group no", isWhereChatAllowed({ id: -200, type: "group" }, "-100"), false);
check("group without config no", isWhereChatAllowed({ id: -100, type: "group" }, undefined), false);
check("no chat", isWhereChatAllowed(null, "-100"), false);

const now = Date.parse("2026-10-22T20:00:00Z");
const drivers = [
  { telegramUserId: 1, driverName: "@bob_tow", lat: 27.95, lon: -82.46, at: "2026-10-22T19:58:00Z" },
  { telegramUserId: 2, driverName: "Alice Smith", lat: 27.9, lon: -82.5, at: "2026-10-22T18:30:00Z" },
];
check("filter all", filterDrivers(drivers, "").length, 2);
check("filter bob", filterDrivers(drivers, "Bob").map((d) => d.telegramUserId), [1]);
check("filter @bob", filterDrivers(drivers, "@bob").map((d) => d.telegramUserId), [1]);
check("filter smith", filterDrivers(drivers, "smith").map((d) => d.telegramUserId), [2]);
check("filter none", filterDrivers(drivers, "zed").length, 0);
check("maps link", mapsLink(27.95, -82.46), "https://maps.google.com/?q=27.950000,-82.460000");
check("fresh line", formatWhereLine(drivers[0], now).includes("2m ago (🟢 fresh)"), true);
check("stale line", formatWhereLine(drivers[1], now).includes("STALE"), true);
const reply = formatWhereReply(drivers, "", now);
check("reply count", reply.includes("(2)"), true);
check("reply newest first", reply.indexOf("@bob_tow") < reply.indexOf("Alice"), true);
check("reply none", formatWhereReply([], "zed", now), 'No driver location found matching "zed".');
check("reply empty", formatWhereReply([], "", now), "No driver locations recorded yet.");

console.log(fail ? `\n${fail} FAILED` : "\nall passed");
process.exit(fail ? 1 : 0);
