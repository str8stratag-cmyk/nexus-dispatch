/**
 * Pure-helper tests for Telegram Accept-button parsing / naming / poll gate.
 * Run: npx tsx trial/test-telegram-accept.ts
 */
import {
  parseAcceptCallbackData,
  formatTelegramAccepterName,
  isTelegramAcceptPollEnabled,
  acceptInitBackoffMs,
  retryUntilSuccess,
  decideAcceptBranch,
  normalizeEventStatus,
  formatAcceptTapLog,
  messageMatchesEvent,
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

// Accept branch decision (2026-10-14 "no longer available" investigation).
check("branch missing", decideAcceptBranch(undefined), "not_found");
check("branch active", decideAcceptBranch({ status: "active" }), "claim");
check("branch Active (case)", decideAcceptBranch({ status: "Active " }), "claim");
check("branch accepted", decideAcceptBranch({ status: "accepted" }), "already_accepted");
check("branch ACCEPTED", decideAcceptBranch({ status: "ACCEPTED" }), "already_accepted");
check("branch resolved", decideAcceptBranch({ status: "resolved" }), "not_available");
check("branch null status", decideAcceptBranch({ status: null }), "not_available");
check("normalize", normalizeEventStatus("  Resolved "), "resolved");
check("msg match", messageMatchesEvent(4879, "4879"), true);
check("msg mismatch", messageMatchesEvent(4870, "4879"), false);
check("msg unknown", messageMatchesEvent(4870, null), null);
{
  const line = formatAcceptTapLog({
    updateId: 1, callbackData: "accept_1818", parsedId: 1818, callbackChatId: "-100", chatMatch: true,
    callbackMessageId: 4879, eventFound: true, eventId: 1818, eventStatus: "active",
    eventTelegramMessageId: "4879", messageMatch: true, dbName: "db", branch: "claimed",
  });
  check("log prefix", line.startsWith("[telegram-accept] {"), true);
  check("log json", JSON.parse(line.slice("[telegram-accept] ".length)).branch, "claimed");
  check("log has no token field", /token/i.test(line), false);
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

// Accept transport setup retry (2026-10-07): 5s doubling to a 120s cap.
check("backoff 1", acceptInitBackoffMs(1), 5_000);
check("backoff 2", acceptInitBackoffMs(2), 10_000);
check("backoff 5", acceptInitBackoffMs(5), 80_000);
check("backoff 6 capped", acceptInitBackoffMs(6), 120_000);
check("backoff huge capped", acceptInitBackoffMs(10_000), 120_000);
check("backoff 0 treated as 1", acceptInitBackoffMs(0), 5_000);

{
  // Mongo down for 3 attempts (like Disp-1 after the 10/07 reboot), then up.
  const sleeps: number[] = [];
  const logs: string[] = [];
  let calls = 0;
  const ok = await retryUntilSuccess(
    async () => {
      calls++;
      if (calls <= 3) throw new Error("Server selection timed out after 8000 ms");
    },
    {
      label: "[telegram] Accept transport setup",
      log: (m) => logs.push(`log:${m}`),
      warn: (m) => logs.push(`warn:${m}`),
      sleep: async (ms) => { sleeps.push(ms); },
    },
  );
  check("retry: resolves true after DB comes back", ok, true);
  check("retry: attempted 4 times", calls, 4);
  check("retry: backoff 5s,10s,20s", sleeps, [5_000, 10_000, 20_000]);
  check("retry: logs each failure", logs.filter((l) => l.startsWith("warn:")).length, 3);
  check(
    "retry: failure line has reason + delay",
    logs[0],
    "warn:[telegram] Accept transport setup failed (attempt 1): Server selection timed out after 8000 ms — retry in 5s",
  );
  check("retry: logs success with attempt", logs[logs.length - 1], "log:[telegram] Accept transport setup succeeded on attempt 4");
}

{
  // First-try success: no retry noise.
  const logs: string[] = [];
  const ok = await retryUntilSuccess(async () => {}, {
    label: "x",
    log: (m) => logs.push(m),
    warn: (m) => logs.push(m),
    sleep: async () => {},
  });
  check("retry: first-try success", ok, true);
  check("retry: first-try success logs nothing", logs.length, 0);
}

{
  // Shutdown: abort during a wait stops retrying without another attempt.
  const ac = new AbortController();
  let calls = 0;
  const ok = await retryUntilSuccess(
    async () => {
      calls++;
      throw new Error("down");
    },
    {
      label: "x",
      signal: ac.signal,
      log: () => {},
      warn: () => {},
      sleep: async () => { ac.abort(); },
    },
  );
  check("retry: abort -> resolves false", ok, false);
  check("retry: abort -> no further attempts", calls, 1);
}

{
  // Real (unref'd) sleep wakes up early on abort instead of waiting 120s.
  const ac = new AbortController();
  const started = Date.now();
  setTimeout(() => ac.abort(), 50);
  const ok = await retryUntilSuccess(
    async () => { throw new Error("down"); },
    { label: "x", initialMs: 120_000, signal: ac.signal, log: () => {}, warn: () => {} },
  );
  check("retry: real sleep aborts early", ok === false && Date.now() - started < 5_000, true);
}

console.log(fail === 0 ? "ALL PASS" : `${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
