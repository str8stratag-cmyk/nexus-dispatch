// Capture recover coordinator (2026-10-21, DISP-5 3:53 PM storm on 298a259).
//
// What kept happening: the watchdog asked for recover, the server told board
// tabs to reload, each reload minted a new tabId that sat at lock=pending (the
// dead old page still held the Web Lock, or Chrome throttled the background
// tab), the outage never cleared, and recover was re-delivered to every new
// tab: 100+ dead tabs. A clean Chrome restart fixed it every time.
//
// Rules (pure + clock/storage injected; tested by trial/test-recover-coordinator.ts):
//  1. Never reload while ANY live tab is lock=pending (request refused AND
//     delivery withheld).
//  2. At most one accepted recover per RECOVER_MIN_GAP_MS (30 min). The
//     timestamp is persisted (survives app restarts / code pulls), and the
//     recover goes to ONE target tab chosen at request time (a live tab that
//     predates the request), once. New tab ids never receive it.
//  3. Dead lock holder: a tab whose last report was lock=held but which has
//     sent no heartbeat and no chunk for DEAD_HOLDER_MS (5 min) is dead. If no
//     live tab holds the lock, ONE waiting tab (pending/standby) is told to
//     steal the Web Lock (client: navigator.locks.request(..., {steal:true}))
//     and the server lease can be taken from the dead holder.
import { TAB_FRESH_MS } from "./capture-lease";

export const RECOVER_MIN_GAP_MS = 30 * 60_000;
export const RECOVER_DELIVERY_TTL_MS = 5 * 60_000;
export const DEAD_HOLDER_MS = 5 * 60_000;
/** After telling one tab to take the lock, wait this long before picking another. */
export const LOCK_TAKEOVER_RETRY_MS = 2 * 60_000;
/** A "capturing with the lock held" tab must have produced a chunk this recently. */
export const CAPTURING_CHUNK_FRESH_MS = 90_000;

export interface CoordTab {
  tabId: string;
  /** Last heartbeat (server clock). */
  at: number;
  firstSeenAt: number;
  lock: string | null;
  capturing: boolean;
  lastChunkAt: number | null;
  origin?: string | null;
}

export interface PersistedRecoverState {
  lastAcceptedAt: number;
  targetTabId: string | null;
  deliveredAt: number;
}

export interface RecoverStore {
  load(): PersistedRecoverState | null;
  save(s: PersistedRecoverState): void;
}

export const memoryStore = (): RecoverStore & { data: PersistedRecoverState | null } => {
  const st = {
    data: null as PersistedRecoverState | null,
    load: () => (st.data ? { ...st.data } : null),
    save: (s: PersistedRecoverState) => {
      st.data = { ...s };
    },
  };
  return st;
};

export const isLive = (t: CoordTab, now: number) => now - t.at <= TAB_FRESH_MS;
export const lastSignalAt = (t: { at: number; lastChunkAt: number | null }) => Math.max(t.at, t.lastChunkAt ?? 0);
/** Holds (last reported) the lock but no heartbeat and no chunk for DEAD_HOLDER_MS. */
export const isDeadLockHolder = (t: CoordTab, now: number) => t.lock === "held" && now - lastSignalAt(t) >= DEAD_HOLDER_MS;
export const isCapturingWithLock = (t: CoordTab, now: number) =>
  isLive(t, now) && t.lock === "held" && t.capturing && t.lastChunkAt != null && now - t.lastChunkAt <= CAPTURING_CHUNK_FRESH_MS;

export type RecoverRequestResult =
  | { accepted: true; targetTabId: string }
  | { accepted: false; reason: "cooldown" | "tab-pending" | "no-live-tab"; retryInMs?: number; pendingTabs?: string[] };

export type HeartbeatReply = { recover?: "reload" | "navigate"; url?: string; takeLock?: true };

export class RecoverCoordinator {
  private state: PersistedRecoverState;
  private lockTakeover: { tabId: string; at: number } | null = null;
  constructor(
    private store: RecoverStore,
    private log: (line: string) => void = () => undefined,
    private canonicalOrigin = "http://localhost:5000",
  ) {
    this.state = store.load() ?? { lastAcceptedAt: 0, targetTabId: null, deliveredAt: 0 };
  }

  snapshot(): PersistedRecoverState {
    return { ...this.state };
  }

  pendingTabs(tabs: Iterable<CoordTab>, now: number): CoordTab[] {
    return Array.from(tabs).filter((t) => isLive(t, now) && t.lock === "pending");
  }

  request(tabs: Iterable<CoordTab>, now: number): RecoverRequestResult {
    const all = Array.from(tabs);
    const since = now - this.state.lastAcceptedAt;
    if (this.state.lastAcceptedAt && since < RECOVER_MIN_GAP_MS) {
      const retryInMs = RECOVER_MIN_GAP_MS - since;
      this.log(`[capture] recover refused: cooldown (last accepted ${Math.round(since / 1000)}s ago, next allowed in ${Math.round(retryInMs / 1000)}s)`);
      return { accepted: false, reason: "cooldown", retryInMs };
    }
    const pending = this.pendingTabs(all, now);
    if (pending.length) {
      this.log(`[capture] recover refused: ${pending.length} live tab(s) lock=pending (${pending.map((t) => t.tabId).join(",")}); not reloading`);
      return { accepted: false, reason: "tab-pending", pendingTabs: pending.map((t) => t.tabId) };
    }
    const live = all.filter((t) => isLive(t, now) && t.firstSeenAt < now);
    if (!live.length) {
      this.log("[capture] recover refused: no live tab to deliver to");
      return { accepted: false, reason: "no-live-tab" };
    }
    // Prefer the lock holder (it is the one that should be capturing), then the freshest tab.
    live.sort((a, b) => Number(b.lock === "held") - Number(a.lock === "held") || b.at - a.at);
    const target = live[0];
    this.state = { lastAcceptedAt: now, targetTabId: target.tabId, deliveredAt: 0 };
    this.store.save(this.state);
    this.log(`[capture] recover accepted -> single target tab=${target.tabId} lock=${target.lock ?? "?"} (live tabs: ${live.length}); next allowed in ${RECOVER_MIN_GAP_MS / 60_000} min`);
    return { accepted: true, targetTabId: target.tabId };
  }

  /** Called on every heartbeat (tabs already updated with this beat). */
  onHeartbeat(tabId: string, tabs: Iterable<CoordTab>, now: number): HeartbeatReply {
    const all = Array.from(tabs);
    const me = all.find((t) => t.tabId === tabId);
    const reply: HeartbeatReply = {};
    const s = this.state;
    if (s.targetTabId === tabId && !s.deliveredAt && s.lastAcceptedAt && now - s.lastAcceptedAt < RECOVER_DELIVERY_TTL_MS) {
      const pending = this.pendingTabs(all, now);
      if (pending.length) {
        this.log(`[capture] recover for tab=${tabId} withheld: ${pending.length} live tab(s) lock=pending`);
      } else {
        const action = me?.origin && me.origin !== this.canonicalOrigin ? "navigate" : "reload";
        this.state = { ...s, deliveredAt: now };
        this.store.save(this.state);
        this.log(`[capture] recover -> tab=${tabId} action=${action} (single delivery)`);
        return { recover: action, url: `${this.canonicalOrigin}/` };
      }
    }
    if (me && isLive(me, now) && (me.lock === "pending" || me.lock === "standby") && this.shouldTakeLock(me, all, now)) {
      reply.takeLock = true;
    }
    return reply;
  }

  private shouldTakeLock(me: CoordTab, all: CoordTab[], now: number): boolean {
    const liveHolder = all.find((t) => t.tabId !== me.tabId && t.lock === "held" && !isDeadLockHolder(t, now));
    if (liveHolder) return false;
    const dead = all.filter((t) => t.tabId !== me.tabId && isDeadLockHolder(t, now));
    // Only act on evidence of a dead holder, or on a tab stuck pending for DEAD_HOLDER_MS.
    const stuckPending = me.lock === "pending" && now - me.firstSeenAt >= DEAD_HOLDER_MS;
    if (!dead.length && !stuckPending) return false;
    const lt = this.lockTakeover;
    if (lt && lt.tabId !== me.tabId && now - lt.at < LOCK_TAKEOVER_RETRY_MS) return false;
    if (lt && lt.tabId === me.tabId && now - lt.at < LOCK_TAKEOVER_RETRY_MS) return true;
    this.lockTakeover = { tabId: me.tabId, at: now };
    this.log(
      `[capture] lock takeover -> tab=${me.tabId} (lock=${me.lock}); dead holder(s): ${dead.map((t) => `${t.tabId} silent ${Math.round((now - lastSignalAt(t)) / 1000)}s`).join(", ") || "none seen, tab pending 5+ min"}`,
    );
    return true;
  }

  status(tabs: Iterable<CoordTab>, now: number) {
    const all = Array.from(tabs);
    const s = this.state;
    return {
      pendingTabs: this.pendingTabs(all, now).length,
      lockHeldCapturingTabs: all.filter((t) => isCapturingWithLock(t, now)).length,
      deadLockHolders: all.filter((t) => isDeadLockHolder(t, now)).map((t) => t.tabId),
      recover: {
        lastAcceptedAgoMs: s.lastAcceptedAt ? now - s.lastAcceptedAt : null,
        nextAllowedInMs: s.lastAcceptedAt ? Math.max(0, RECOVER_MIN_GAP_MS - (now - s.lastAcceptedAt)) : 0,
        targetTabId: s.targetTabId,
        delivered: s.deliveredAt > 0,
      },
    };
  }
}
