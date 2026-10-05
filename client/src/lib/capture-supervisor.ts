// Capture self-healing policy (2026-10-03). Pure functions only, so the
// decisions can be unit-tested without a browser (trial/test-capture-supervisor.ts).
//
// Why this exists: on 2026-10-02 (and 2026-09-24) desk updates stopped capture
// with nobody present to press Start again:
//  - a git pull hot-patched the live page (Vite HMR / React Fast Refresh),
//    which re-runs effects: the capture hook's unmount cleanup stopped the
//    mic, and the one-shot auto-start was guarded by a ref that survives Fast
//    Refresh, so it never ran again -> capture sat IDLE;
//  - the one-shot auto-start was also cancelled by any re-render while it
//    was in flight (its callback identity changed every render);
//  - nothing noticed a capture pipeline that had silently stopped producing
//    chunks.
// The supervisor replaces the one-shot with a persistent "auto-capture"
// intent plus a retry/stall loop that never gives up.

/** localStorage key holding the operator's capture intent. */
export const AUTO_CAPTURE_KEY = "dispatch.autoCapture";
/** localStorage key for the last supervisor-forced page reload (ms epoch). */
export const LAST_FORCED_RELOAD_KEY = "dispatch.lastForcedReload";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

/**
 * Auto-capture is ON unless an operator explicitly pressed Stop. Unset (every
 * desk before this change shipped) counts as ON, matching the old behaviour
 * of auto-starting on every page load.
 */
export function readAutoCapture(storage: StorageLike | undefined): boolean {
  try {
    return storage?.getItem(AUTO_CAPTURE_KEY) !== "off";
  } catch {
    return true;
  }
}

export function writeAutoCapture(storage: StorageLike | undefined, on: boolean): void {
  try {
    storage?.setItem(AUTO_CAPTURE_KEY, on ? "on" : "off");
  } catch {
    // Storage unavailable/full: the in-memory intent still applies this session.
  }
}

/** Retry delay after `failures` consecutive failed starts: 2s, 4s, 8s ... capped. */
export function startBackoffMs(failures: number, baseMs = 2_000, capMs = 60_000): number {
  if (!Number.isFinite(failures) || failures <= 0) return 0;
  const exp = Math.min(failures - 1, 20);
  return Math.min(capMs, baseMs * 2 ** exp);
}

/**
 * How long capture may run without the recorder finishing a chunk before the
 * pipeline counts as stalled. A healthy recorder finishes one chunk every
 * chunkMs no matter how quiet the room is (silent chunks are produced, just
 * not POSTed), so this deliberately does NOT key off Whisper POSTs: a quiet
 * scanner legitimately sends nothing for long stretches.
 */
export function stallThresholdMs(chunkMs: number): number {
  return Math.max(3 * chunkMs + 5_000, 20_000);
}

export interface CaptureHealth {
  /** ms epoch when capture (re)started, or 0 if not capturing. */
  startedAt: number;
  /** ms epoch when the recorder last finished a chunk, or 0 if never. */
  lastChunkAt: number;
}

/**
 * `tickGapMs` is how late the supervisor's own timer fired. Chrome throttles
 * timers in background tabs (down to ~1/min after 5 min hidden), which also
 * stretches the recorder's chunk timer; scaling the threshold by the observed
 * timer gap keeps a throttled-but-healthy tab from being "restarted" every
 * minute, while a visible tab keeps the tight ~20s threshold.
 */
export function isStalled(health: CaptureHealth, now: number, chunkMs: number, tickGapMs = 0): boolean {
  if (!health.startedAt) return false;
  const lastProgress = Math.max(health.startedAt, health.lastChunkAt);
  const threshold = Math.max(stallThresholdMs(chunkMs), 2.5 * (Number.isFinite(tickGapMs) ? tickGapMs : 0));
  return now - lastProgress > threshold;
}

/** Minimum gap between supervisor-forced page reloads (last-resort recovery). */
export const MIN_FORCED_RELOAD_GAP_MS = 10 * 60_000;

export interface ReloadDecisionInput {
  now: number;
  /** Pipeline restarts / failed starts since capture was last healthy. */
  recoveriesSinceHealthy: number;
  /** ms epoch since which capture has been wanted but not healthy (0 = healthy). */
  unhealthySince: number;
  /** ms epoch of the last forced reload (from storage), 0 if none. */
  lastForcedReloadAt: number;
}

/**
 * Last resort: reload the page when in-page restarts keep failing. Requires
 * several failed recoveries AND at least 3 minutes unhealthy, and never more
 * than once per MIN_FORCED_RELOAD_GAP_MS, so a box with a genuinely missing
 * mic does not reload-loop.
 */
export function shouldForceReload(input: ReloadDecisionInput): boolean {
  if (input.recoveriesSinceHealthy < 4) return false;
  if (!input.unhealthySince || input.now - input.unhealthySince < 3 * 60_000) return false;
  if (input.lastForcedReloadAt && input.now - input.lastForcedReloadAt < MIN_FORCED_RELOAD_GAP_MS) return false;
  return true;
}

export function readLastForcedReload(storage: StorageLike | undefined): number {
  try {
    const value = Number.parseInt(storage?.getItem(LAST_FORCED_RELOAD_KEY) ?? "", 10);
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

export function writeLastForcedReload(storage: StorageLike | undefined, at: number): void {
  try {
    storage?.setItem(LAST_FORCED_RELOAD_KEY, String(at));
  } catch {
    // ignore
  }
}

/** True for getUserMedia errors that retrying cannot fix without a human. */
export function isPermissionError(err: unknown): boolean {
  const e = err as { name?: string; message?: string } | null;
  if (!e) return false;
  if (e.name === "NotAllowedError" || e.name === "SecurityError") return true;
  const msg = (e.message || "").toLowerCase();
  return msg.includes("not allowed") || msg.includes("permission");
}
