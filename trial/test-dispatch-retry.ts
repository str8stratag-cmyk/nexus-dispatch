// Dispatch write retry queue (2026-10-21, DISP-1 11:02 AM querySrv ETIMEOUT lost call).
// Run: npx tsx trial/test-dispatch-retry.ts
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DispatchRetryQueue,
  isTransientDbError,
  retryDelayMs,
  RETRY_BASE_MS,
  RETRY_MAX_MS,
  RETRY_MAX_AGE_MS,
} from "../server/dispatch-retry-queue";

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}: ${name}${ok ? "" : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`);
}

// Classification: the real error strings from the desk logs.
check("querySrv ETIMEOUT", isTransientDbError(new Error("querySrv ETIMEOUT _mongodb._tcp.nexus-disp.example.mongodb.net")), true);
check("server selection", isTransientDbError(new Error("Server selection timed out after 8000 ms")), true);
const sel = new Error("x"); sel.name = "MongoServerSelectionError";
check("MongoServerSelectionError name", isTransientDbError(sel), true);
check("ECONNRESET", isTransientDbError(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })), true);
check("wrapped cause", isTransientDbError(new Error("outer", { cause: new Error("getaddrinfo ENOTFOUND host") })), true);
const zod = new Error("Expected string"); zod.name = "ZodError";
check("ZodError is not transient", isTransientDbError(zod), false);
check("validation error not transient", isTransientDbError(new Error("Invalid address")), false);
check("null", isTransientDbError(null), false);

check("backoff 1", retryDelayMs(1), RETRY_BASE_MS);
check("backoff 3", retryDelayMs(3), RETRY_BASE_MS * 4);
check("backoff capped", retryDelayMs(30), RETRY_MAX_MS);

async function main() {
  const dir = mkdtempSync(path.join(tmpdir(), "dmq-"));
  const file = path.join(dir, "dispatch-retry-queue.json");
  let now = 1_000_000;
  const clock = () => now;

  const q = new DispatchRetryQueue(file, clock);
  const id = q.enqueue({ transcript: "Signal 4 at Dale Mabry and Cypress", source: "DISP-1", _id: "abc" }, new Error("querySrv ETIMEOUT"));
  check("enqueued", q.size, 1);
  check("persisted to disk", JSON.parse(readFileSync(file, "utf8")).length, 1);
  check("_id stripped (echo short-circuit must not swallow replay)", "_id" in q.list()[0].body, false);

  // Survives a restart.
  const q2 = new DispatchRetryQueue(file, clock);
  check("reloaded after restart", q2.size, 1);
  check("same id", q2.list()[0].id, id);

  // Not due yet: nothing sent.
  let sends = 0;
  await q2.drain(async () => { sends++; return "done"; });
  check("not replayed before nextAt", sends, 0);

  // Due, backend still down: kept, backoff grows.
  now += RETRY_BASE_MS;
  await q2.drain(async () => { sends++; return "retry"; });
  check("still queued after transient replay", q2.size, 1);
  check("attempts counted", q2.list()[0].attempts, 1);
  check("next attempt backed off", q2.list()[0].nextAt, now + retryDelayMs(1));

  // Throwing sender counts as retry, never drops.
  now += RETRY_MAX_MS;
  await q2.drain(async () => { throw new Error("fetch failed"); });
  check("exception keeps item", q2.size, 1);

  // Backend back: replayed (server answer is definitive: created / duplicate / rejected).
  now += RETRY_MAX_MS;
  let body: unknown = null;
  const done = await q2.drain(async (item) => { body = item.body; return "done"; });
  check("replayed", done, 1);
  check("queue empty", q2.size, 0);
  check("body replayed intact", (body as { transcript?: string })?.transcript, "Signal 4 at Dale Mabry and Cypress");
  check("empty on disk", JSON.parse(readFileSync(file, "utf8")).length, 0);

  // Stops a pass at the first transient failure (doesn't hammer a down backend).
  q2.enqueue({ n: 1 }, "e"); q2.enqueue({ n: 2 }, "e");
  now += RETRY_BASE_MS;
  let calls = 0;
  await q2.drain(async () => { calls++; return "retry"; });
  check("one call per pass while down", calls, 1);

  // Expired items go to the dead-letter callback, not silently.
  now += RETRY_MAX_AGE_MS + 1;
  const dead: unknown[] = [];
  await q2.drain(async () => "done", (item) => dead.push(item.body));
  check("expired items dead-lettered", dead.length, 2);
  check("queue empty after dead-letter", q2.size, 0);

  // Corrupt file is moved aside, not deleted.
  writeFileSync(file, "{not json");
  const q3 = new DispatchRetryQueue(file, clock);
  check("corrupt file -> empty queue", q3.size, 0);
  check("corrupt file kept aside", readdirSync(dir).some((f) => f.includes(".corrupt-")), true);
  check("original path free", existsSync(file), false);

  console.log(failures ? `${failures} FAILURES` : "all dispatch-retry tests passed");
  process.exit(failures ? 1 : 0);
}
void main();
