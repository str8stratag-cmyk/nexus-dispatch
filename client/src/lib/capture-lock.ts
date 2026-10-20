// One capturing tab per desk (per origin). The supervisor restarts capture on
// its own now, and the watchdog may open a fresh tab when it hears no capture
// heartbeat, so two tabs could otherwise both capture the same mic and double
// Whisper load + dispatches. The first tab to load holds a Web Lock; other
// tabs stay on standby and take over automatically if the holder closes or
// crashes (the browser releases the lock).
//
// 2026-10-20 (DISP-1): a holder that is NOT capturing (lease lost to another
// tab, mic permission missing) used to keep the lock for its whole lifetime,
// while the tab actually capturing sat in "standby" with its supervisor
// disabled. Now an idle holder yields (releaseCaptureLock: it re-queues behind
// the waiting tab), and the supervisor also runs in a standby tab that owns
// the server lease and is capturing -- the lease (one per box, any origin) is
// the authority on who captures. See decideTabAction in shared/capture-lease.ts.
//
// State lives on window so a re-executed module (HMR) reuses the same request
// instead of queueing behind its own never-released lock.

export type CaptureLockState = "pending" | "held" | "standby";

interface LockStore {
  state: CaptureLockState;
  listeners: Set<() => void>;
  /** Resolves the promise that keeps the current lock held. */
  release: (() => void) | null;
}

const LOCK_NAME = "dispatch-monitor-capture";

function set(s: LockStore, next: CaptureLockState) {
  if (s.state === next) return;
  s.state = next;
  s.listeners.forEach((fn) => fn());
}

// Exactly one outstanding lock request per tab. The first is ifAvailable (so
// "standby" shows at once when another tab holds it); later ones queue and
// take over when the holder closes, crashes, or yields.
function request(s: LockStore, locks: LockManager, ifAvailable: boolean) {
  let acquired = false;
  locks
    .request(LOCK_NAME, { ifAvailable }, (lock) => {
      if (!lock) {
        set(s, "standby");
        return undefined;
      }
      acquired = true;
      set(s, "held");
      return new Promise<void>((resolve) => {
        s.release = resolve;
      });
    })
    .catch(() => {
      // Never let a lock failure block capture (no Web Locks in this context).
      if (!acquired && s.state === "pending") set(s, "held");
    })
    .finally(() => {
      if (acquired) {
        s.release = null;
        set(s, "standby");
      }
      if (s.state === "standby") request(s, locks, false);
    });
}

function store(): LockStore {
  const w = window as Window & { __dmCaptureLock?: LockStore };
  if (w.__dmCaptureLock) return w.__dmCaptureLock;
  const s: LockStore = { state: "pending", listeners: new Set(), release: null };
  w.__dmCaptureLock = s;
  const locks = (navigator as Navigator & { locks?: LockManager }).locks;
  if (!locks?.request) {
    set(s, "held");
    return s;
  }
  request(s, locks, true);
  return s;
}

export function getCaptureLockState(): CaptureLockState {
  return store().state;
}

export function subscribeCaptureLock(fn: () => void): () => void {
  const s = store();
  s.listeners.add(fn);
  return () => s.listeners.delete(fn);
}

/** Idle holder: hand the lock to the next waiting tab (this tab re-queues behind it). */
export function releaseCaptureLock(): boolean {
  const s = store();
  if (s.state !== "held" || !s.release) return false;
  console.warn("[capture-lock] idle holder yielding the capture lock");
  s.release();
  return true;
}
