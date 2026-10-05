// Per-box single-capturer lease (2026-10-03). Web Locks (client/src/lib/
// capture-lock.ts) only exclude tabs of the SAME origin, but desks have had
// capture tabs on both http://127.0.0.1:5000 and http://localhost:5000, and
// DISP-2 was seen sending the same audio to Whisper twice. Every tab of either
// origin talks to the same Express server, so the server hands out one
// renewable lease per box. Pure logic here so it is unit-testable
// (trial/test-capture-supervisor.ts); server/routes.ts holds the state.

export const LEASE_TTL_MS = 150_000; // > Chrome's ~60s background timer throttling
export const LEASE_RENEW_MS = 15_000;

export interface CaptureLease {
  tabId: string;
  expiresAt: number;
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
  const grant = (): LeaseDecision => ({ lease: { tabId: req.tabId, expiresAt: now + LEASE_TTL_MS }, granted: true });
  if (!req.tabId) return { lease: live, granted: false };
  if (req.force) return grant();
  if (live) return live.tabId === req.tabId ? grant() : { lease: live, granted: false };
  return grant();
}

export function releaseLease(current: CaptureLease | null, tabId: string): CaptureLease | null {
  return current && current.tabId === tabId ? null : current;
}
