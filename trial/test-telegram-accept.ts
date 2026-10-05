/**
 * Pure-helper tests for Telegram Accept-button parsing / naming / poll gate.
 * Run: npx tsx trial/test-telegram-accept.ts
 */
import {
  parseAcceptCallbackData,
  formatTelegramAccepterName,
  isTelegramAcceptPollEnabled,
} from "../server/telegram-accept-helpers";

let fail = 0;

function check(label: string, got: unknown, want: unknown) {
  const ok = Object.is(got, want) || JSON.stringify(got) === JSON.stringify(want);
  if (!ok) {
    fail++;
    console.log("FAIL:", label, "| got:", got, "| want:", want);
  } else {
    console.log("ok  :", label);
  }
}

check("accept_42", parseAcceptCallbackData("accept_42"), 42);
check("accept_0", parseAcceptCallbackData("accept_0"), 0);
check("reject bare", parseAcceptCallbackData("accept_"), null);
check("reject other", parseAcceptCallbackData("decline_1"), null);
check("reject null", parseAcceptCallbackData(null), null);
check("reject garbage", parseAcceptCallbackData("accept_abc"), null);

check("username", formatTelegramAccepterName({ id: 1, username: "driver_bob" }), "@driver_bob");
check("first_name", formatTelegramAccepterName({ id: 2, first_name: "Bob" }), "Bob");
check("id only", formatTelegramAccepterName({ id: 99 }), "User 99");
check("empty", formatTelegramAccepterName(null), "A driver");
check("empty obj", formatTelegramAccepterName({}), "A driver");

const prev = process.env.TELEGRAM_ACCEPT_POLL;
function withEnv(v: string | undefined, label: string, want: boolean) {
  if (v === undefined) delete process.env.TELEGRAM_ACCEPT_POLL;
  else process.env.TELEGRAM_ACCEPT_POLL = v;
  check(`poll gate ${label}`, isTelegramAcceptPollEnabled(), want);
}
withEnv(undefined, "unset", false);
withEnv("", "empty", false);
withEnv("0", "0", false);
withEnv("false", "false", false);
withEnv("1", "1", true);
withEnv("true", "true", true);
withEnv("YES", "YES", true);
withEnv(" on ", "on padded", true);
if (prev === undefined) delete process.env.TELEGRAM_ACCEPT_POLL;
else process.env.TELEGRAM_ACCEPT_POLL = prev;

console.log(fail === 0 ? "ALL PASS" : `${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
