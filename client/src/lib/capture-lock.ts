// One capturing tab per desk (per origin). The supervisor restarts capture on
// its own now, and the watchdog may open a fresh tab when it hears no capture
// heartbeat, so two tabs could otherwise both capture the same mic and double
// Whisper load + dispatches. The first tab to load holds a Web Lock for its
// whole lifetime; other tabs stay on standby and take over automatically if
// the holder closes or crashes (the browser releases the lock).
//
// State lives on window so a re-executed module (HMR) reuses the same request
// instead of queueing behind its own never-released lock.

export type CaptureLockState = "pending" | "held" | "standby";

interface LockStore {
  state: CaptureLockState;
  listeners: Set<() => void>;
}

const LOCK_NAME = "dispatch-monitor-capture";

function store(): LockStore {
  const w = window as Window & { __dmCaptureLock?: LockStore };
  if (w.__dmCaptureLock) return w.__dmCaptureLock;
  const s: LockStore = { state: "pending", listeners: new Set() };
  w.__dmCaptureLock = s;
  const set = (next: CaptureLockState) => {
    s.state = next;
    s.listeners.forEach((fn) => fn());
  };
  const locks = (navigator as Navigator & { locks?: LockManager }).locks;
  if (!locks?.request) {
    set("held");
    return s;
  }
  // ifAvailable first so we can show "standby" immediately when another tab
  // holds it; then queue normally to take over when that tab goes away.
  locks
    .request(LOCK_NAME, { ifAvailable: true }, (lock) => {
      if (lock) {
        set("held");
        return new Promise<void>(() => undefined); // hold until unload
      }
      set("standby");
      return undefined;
    })
    .then(() => {
      if (s.state !== "standby") return;
      return locks.request(LOCK_NAME, () => {
        set("held");
        return new Promise<void>(() => undefined);
      });
    })
    .catch(() => set("held")); // never let a lock failure block capture
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
