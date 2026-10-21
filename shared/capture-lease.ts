// Per-box single-capturer lease (2026-10-03). Web Locks (client/src/lib/
// capture-lock.ts) only exclude tabs of the SAME origin, but desks have had
// capture tabs on both http://127.0.0.1:5000 and http://localhost:5000, and
// DISP-2 was seen sending the same audio to Whisper twice. Every tab of either
// origin talks to the same Express server, so the server hands out one
// renewable lease per box. Pure logic here so it is unit-testable
// (trial/test-capture-supervisor.ts); server/routes.ts holds the state.

export const LEASE_TTL_MS = 150_000; // > Chrome's ~60s background timer throttling
export const LEASE_RENEW_MS = 15_000;

/** A lease holder that reports "not capturing" this long can be displaced by a capturing tab. */
export const LEASE_IDLE_GRACE_MS = 30_000;
/** A tab holding the lock/lease without capturing gets this long to start before it yields. */
export const HOLDER_IDLE_GRACE_MS = 20_000;

export interface CaptureLease {
  tabId: string;
  expiresAt: number;
  /** Holder's last reported capture state (absent on old leases = treat as capturing). */
  capturing?: boolean;
  /** When the holder started reporting "not capturing" (null while capturing). */
  idleSince?: number | null;
}

export interface LeaseRequest {
  tabId: string;
  /** The tab is capturing right now (informational; logged by the server). */
  capturing: boolean;
  /** Operator pressed Start in this tab: take the lease over. */
  force?: boolean;
}

export interface LeaseDecision {
  lease: CaptureLease | null;
  granted: boolean;
}

// No post-restart grace window on purpose: after an app restart the lease
// table is empty and the first tab to ask wins. If that is a standby tab, the
// previously capturing tab is denied on its next renewal and stops, so there
// is still exactly one capturer (a few seconds' handover), and a lone fresh
// page never waits to start.
export function decideLease(
  current: CaptureLease | null,
  req: LeaseRequest,
  now: number,
): LeaseDecision {
  const live = current && current.expiresAt > now ? current : null;
  const grant = (): LeaseDecision => {
    const keepIdle = live && live.tabId === req.tabId && live.idleSince != null ? live.idleSince : now;
    return {
      lease: {
        tabId: req.tabId,
        expiresAt: now + LEASE_TTL_MS,
        capturing: req.capturing,
        idleSince: req.capturing ? null : keepIdle,
      },
      granted: true,
    };
  };
  if (!req.tabId) return { lease: live, granted: false };
  if (req.force) return grant();
  if (!live || live.tabId === req.tabId) return grant();
  // 2026-10-20 (DISP-1): the holder stopped capturing while another tab is
  // capturing -- hand the lease to the tab that is actually recording.
  if (req.capturing && live.capturing === false && live.idleSince != null && now - live.idleSince >= LEASE_IDLE_GRACE_MS) {
    return grant();
  }
  return { lease: live, granted: false };
}

export function releaseLease(current: CaptureLease | null, tabId: string): CaptureLease | null {
  return current && current.tabId === tabId ? null : current;
}

// ---- Per-tab policy (2026-10-20) -------------------------------------------
// DISP-1 had two capture tabs: A held the Web Lock but was not capturing, B
// was capturing in "standby" (its supervisor disabled). Pure decision so it is
// unit-testable; audio-panel.tsx runs it on every supervisor tick.

export type TabAction = "none" | "stop" | "yield";

export interface TabSnapshot {
  lock: "pending" | "held" | "standby";
  lease: "unknown" | "granted" | "denied";
  capturing: boolean;
  autoCapture: boolean;
  /** Mic permission state, "unknown" if the Permissions API is unavailable. */
  micPermission: "granted" | "prompt" | "denied" | "unknown";
  /** When this tab began holding the lock without capturing (0 = not idle). */
  idleHolderSince: number;
  now: number;
}

/**
 * - "stop": another tab owns the lease; never run a second capture.
 * - "yield": this tab holds the lock but is not capturing and cannot or may
 *   not start (operator Stop, lease denied, mic not granted, or still idle
 *   after HOLDER_IDLE_GRACE_MS): release lock + lease so another tab captures.
 */
export function decideTabAction(t: TabSnapshot): TabAction {
  if (t.lease === "denied" && t.capturing) return "stop";
  if (t.lock !== "held" || t.capturing) return "none";
  if (!t.autoCapture) return "yield";
  if (!t.idleHolderSince) return "none";
  const idleFor = t.now - t.idleHolderSince;
  if (idleFor < HOLDER_IDLE_GRACE_MS) return "none";
  if (t.lease === "denied" || t.micPermission === "denied" || t.micPermission === "prompt") return "yield";
  // Permission is fine and we own the lease: keep trying to start (the
  // supervisor backs off), but give up the slot after 3x the grace so a
  // waiting tab gets a turn.
  return idleFor >= 3 * HOLDER_IDLE_GRACE_MS ? "yield" : "none";
}

/** Supervisor may (re)start/heal capture in this tab. */
export function mayRunCapture(lock: TabSnapshot["lock"], lease: TabSnapshot["lease"], capturing: boolean): boolean {
  if (lease === "denied") return false;
  if (lock === "held") return true;
  // Standby but capturing and the server says this tab owns the lease: it is
  // THE capturer, so keep healing it (stall restarts) instead of idling.
  return capturing && lease === "granted";
}

// ---- Per-tab heartbeats -> per-desk status ---------------------------------

/** A tab is considered live if it heartbeated within this window. */
export const TAB_FRESH_MS = 150_000;
/** Forget tabs silent for this long. */
export const TAB_FORGET_MS = 30 * 60_000;

export interface TabHeartbeat {
  tabId: string;
  at: number;
  origin: string | null;
  capturing: boolean;
  lock: string | null;
  lease: string | null;
  /** Epoch ms of this tab's last recorder chunk (server clock), null if none. */
  lastChunkAt: number | null;
  /** Epoch ms of this tab's last successful Whisper POST (server clock), null if none. */
  lastSentAt: number | null;
}

export interface DeskCaptureSummary {
  liveTabs: number;
  capturingTabs: number;
  /** At least one live tab is capturing and produced a chunk recently. */
  effectiveCapturing: boolean;
  lastChunkAt: number | null;
  lastChunkAgoMs: number | null;
  lastSentAt: number | null;
  lastSentAgoMs: number | null;
}

export function pruneTabs(tabs: Map<string, TabHeartbeat>, now: number): void {
  tabs.forEach((t, id) => {
    if (now - t.at > TAB_FORGET_MS) tabs.delete(id);
  });
}

export function summarizeDesk(tabs: Iterable<TabHeartbeat>, now: number, chunkStaleMs: number): DeskCaptureSummary {
  let liveTabs = 0;
  let capturingTabs = 0;
  let lastChunkAt: number | null = null;
  let lastSentAt: number | null = null;
  for (const t of Array.from(tabs)) {
    if (t.lastChunkAt != null && (lastChunkAt == null || t.lastChunkAt > lastChunkAt)) lastChunkAt = t.lastChunkAt;
    if (t.lastSentAt != null && (lastSentAt == null || t.lastSentAt > lastSentAt)) lastSentAt = t.lastSentAt;
    if (now - t.at > TAB_FRESH_MS) continue;
    liveTabs++;
    if (t.capturing) capturingTabs++;
  }
  const lastChunkAgoMs = lastChunkAt == null ? null : now - lastChunkAt;
  return {
    liveTabs,
    capturingTabs,
    effectiveCapturing: capturingTabs > 0 && lastChunkAgoMs != null && lastChunkAgoMs <= chunkStaleMs,
    lastChunkAt,
    lastChunkAgoMs,
    lastSentAt,
    lastSentAgoMs: lastSentAt == null ? null : now - lastSentAt,
  };
}
