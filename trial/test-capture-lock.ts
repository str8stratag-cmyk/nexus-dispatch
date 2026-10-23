// Client-side capture lock timeout (2026-10-23): navigator.locks.request({ifAvailable:true})
// is supposed to settle at once, but a hung/broken Web Locks implementation left a tab
// stuck at lock=pending forever on at least one desk -- and the server never reloads ANY
// tab on a desk while a live tab reports lock=pending (shared/capture-recover-coordinator.ts),
// so one stuck tab could veto recovery for the whole desk. Verifies capture-lock.ts aborts a
// hung request after LOCK_REQUEST_TIMEOUT_MS so "pending" always reaches a terminal state,
// without disturbing the normal fast paths (lock granted / lock unavailable / genuine failure).
// Run: npx tsx trial/test-capture-lock.ts
//
// No DOM in this runtime: `window` and `navigator` are stubbed as plain globals (Node has no
// built-in `window`; it does ship a real `navigator.locks` as of Node 24, so that getter-only
// global is overridden with Object.defineProperty instead of a plain assignment).

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}: ${name}${ok ? "" : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`);
}

// ---- Fake macrotask timers (so the test doesn't actually wait 12s) --------
interface FakeTimer {
  id: number;
  cb: () => void;
  cancelled: boolean;
}
let timers: FakeTimer[] = [];
let nextTimerId = 1;
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
function installFakeTimers() {
  timers = [];
  (globalThis as unknown as { setTimeout: unknown }).setTimeout = ((cb: () => void) => {
    const t: FakeTimer = { id: nextTimerId++, cb, cancelled: false };
    timers.push(t);
    return t.id;
  }) as typeof setTimeout;
  (globalThis as unknown as { clearTimeout: unknown }).clearTimeout = ((id: number) => {
    const t = timers.find((x) => x.id === id);
    if (t) t.cancelled = true;
  }) as typeof clearTimeout;
}
function restoreRealTimers() {
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
}
/** Run every still-scheduled (not cleared) fake timer, as if its delay elapsed. */
function fireFakeTimers() {
  for (const t of timers.filter((x) => !x.cancelled)) t.cb();
}
/** Let queued microtasks (promise .then/.catch/.finally chains) run before asserting. */
function flush(): Promise<void> {
  return new Promise((resolve) => realSetTimeout(resolve, 0));
}

function freshWindow() {
  Object.defineProperty(globalThis, "window", { value: {}, configurable: true, writable: true });
}
function setLocks(locks: unknown) {
  Object.defineProperty(globalThis, "navigator", { value: { locks }, configurable: true, writable: true });
}

type LockCallback = (lock: { name: string } | null) => Promise<void> | undefined;

async function main() {
  const { getCaptureLockState } = await import("../client/src/lib/capture-lock.ts");

  // 1. Hung request (callback never invoked, promise never settles on its own):
  // after the timeout fires, the tab must leave "pending" (fall back to the
  // normal queued wait, not stuck forever).
  {
    installFakeTimers();
    freshWindow();
    setLocks({
      request: (_name: string, opts: { signal?: AbortSignal }, _cb: LockCallback) =>
        new Promise<void>((_resolve, reject) => {
          opts.signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            (err as { name?: string }).name = "AbortError";
            reject(err);
          });
          // Otherwise never settles and never calls back -- simulates a wedged
          // Web Locks implementation.
        }),
    });
    check("hung request: starts pending", getCaptureLockState(), "pending");
    fireFakeTimers(); // simulate the ~12s timeout elapsing
    await flush();
    check("hung request: timeout moves pending to a terminal state (standby)", getCaptureLockState(), "standby");
    restoreRealTimers();
  }

  // 2. Lock granted promptly: per the Web Locks spec, the outer request()
  // promise (and so our .finally()'s clearTimeout) doesn't settle until the
  // lock is later released -- held can last the whole session -- so the real
  // guarantee is the state guard in the timeout callback: firing it late
  // while the state is already "held" (not "pending") must still no-op.
  {
    installFakeTimers();
    freshWindow();
    setLocks({
      request: (_name: string, _opts: unknown, cb: LockCallback) => cb({ name: "dispatch-monitor-capture" }) ?? Promise.resolve(),
    });
    getCaptureLockState(); // trigger store()/request()
    await flush();
    check("granted: tab holds the lock", getCaptureLockState(), "held");
    fireFakeTimers(); // as if the ~12s timeout elapsed while still holding the lock
    await flush();
    check("granted: still held after a (no-op) timer fire", getCaptureLockState(), "held");
    restoreRealTimers();
  }

  // 3. Lock unavailable (ifAvailable:true resolves with null immediately): goes
  // straight to standby, independent of the timeout, which is cleared.
  {
    installFakeTimers();
    freshWindow();
    setLocks({
      // Only the ifAvailable:true call resolves with null; the follow-up
      // ifAvailable:false retry queues indefinitely (as it would for real),
      // so the module's own "re-request while standby" loop stops after one hop.
      request: (_name: string, opts: { ifAvailable?: boolean }, cb: LockCallback) => {
        if (opts?.ifAvailable) {
          cb(null);
          return Promise.resolve();
        }
        return new Promise<void>(() => undefined);
      },
    });
    getCaptureLockState(); // trigger store()/request()
    await flush();
    check("unavailable: tab goes to standby immediately", getCaptureLockState(), "standby");
    check("unavailable: timeout was cleared", timers.every((t) => t.cancelled), true);
    restoreRealTimers();
  }

  // 4. Genuine request() failure (not our timeout): preserves the original
  // "never let a lock failure block capture" fallback -- goes to held, not standby.
  {
    installFakeTimers();
    freshWindow();
    setLocks({
      request: () => Promise.reject(new Error("Web Locks unavailable in this context")),
    });
    getCaptureLockState(); // trigger store()/request()
    await flush();
    check("genuine failure: falls back to held (capture not blocked)", getCaptureLockState(), "held");
    restoreRealTimers();
  }

  console.log(failures ? `${failures} FAILURES` : "all capture-lock tests passed");
  process.exit(failures ? 1 : 0);
}

void main();
