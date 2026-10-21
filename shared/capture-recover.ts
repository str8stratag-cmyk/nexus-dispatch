// Capture recovery policy (2026-10-21, DISP-5 reload storm after d0ed149).
//
// What happened: the watchdog asked for recovery while DISP-5's only tab was
// healthy on quiet radio (chunks flowing, sent=0 because the silence gate drops
// silent chunks, level "?" because the tab still ran the pre-update bundle).
// The server then told EVERY tab id it had not told yet, for 5 minutes, to
// reload. A reload mints a new tab id, so each fresh page was told to reload on
// its first heartbeat, before it could start capturing: 252 reloads, 58+ live
// tabs, nothing captured, and the watchdog re-requested because nothing captured.
//
// Rules here (pure, unit-tested in trial/test-recover-storm.ts):
//  1. Recover is delivered only to tabs first seen BEFORE the request, once each.
//  2. The server accepts a recover request at most once per CAPTURE_RECOVER_MIN_GAP_MS,
//     and never while one is still pending.
//  3. Outage = chunks stopped, or chunks flowing with a REPORTED level of 0.
//     A missing level is unknown (fall back to chunk age). Quiet radio
//     (chunks flowing, sent=0, level>0 or unknown) is NOT an outage.
//  4. No recover within RECOVER_COOLDOWN_MS of an app restart / code pull, and
//     never while live tabs > 1 and growing (that is a storm in progress).

export const CAPTURE_RECOVER_TTL_MS = 5 * 60_000;
export const CAPTURE_RECOVER_MIN_GAP_MS = 10 * 60_000;
export const RECOVER_COOLDOWN_MS = 10 * 60_000;
/** Watchdog hard cap: at most this many recover requests per rolling hour. */
export const MAX_RECOVERS_PER_HOUR = 3;

export function shouldDeliverRecover(input: {
  requestedAt: number;
  ttlMs: number;
  now: number;
  /** First heartbeat seen from this tab id (server clock). */
  tabFirstSeenAt: number;
  /** When this tab was last told (0 = never). */
  toldAt: number;
}): boolean {
  if (!input.requestedAt || input.now - input.requestedAt >= input.ttlMs) return false;
  // A tab that appeared after the request is (usually) the reload we asked for.
  if (input.tabFirstSeenAt >= input.requestedAt) return false;
  return input.toldAt < input.requestedAt;
}

export type RecoverRequestDecision = { accepted: true } | { accepted: false; reason: "pending" | "too-soon" };

export function acceptRecoverRequest(input: { lastAcceptedAt: number; now: number; ttlMs?: number; minGapMs?: number }): RecoverRequestDecision {
  const ttl = input.ttlMs ?? CAPTURE_RECOVER_TTL_MS;
  const gap = input.minGapMs ?? CAPTURE_RECOVER_MIN_GAP_MS;
  if (!input.lastAcceptedAt) return { accepted: true };
  const since = input.now - input.lastAcceptedAt;
  if (since < ttl) return { accepted: false, reason: "pending" };
  if (since < gap) return { accepted: false, reason: "too-soon" };
  return { accepted: true };
}

export interface CaptureStatusLike {
  uptimeMs: number;
  liveTabs: number;
  /** Tabs that want to capture (fresh heartbeat, autoCapture on). */
  wantingTabs: number;
  lastChunkAgoMs: number | null;
  /** Last minute (any tab) that reported a level at all (null = never: old bundle). */
  levelReportedAgoMs: number | null;
  /** Last minute (any tab) with a nonzero level. */
  nonzeroLevelAgoMs: number | null;
}

export type OutageDecision = { outage: false; why: string } | { outage: true; why: string };

/** Mirror of Get-CaptureOutageDecision in scripts/watchdog.ps1 (keep in sync). */
export function classifyCaptureOutage(s: CaptureStatusLike, limitMs: number): OutageDecision {
  if (s.uptimeMs < limitMs) return { outage: false, why: "app just started" };
  if (s.liveTabs === 0) return { outage: false, why: "no live tab (no-heartbeat check handles it)" };
  if (s.wantingTabs === 0) return { outage: false, why: "operator stopped capture" };
  if (s.lastChunkAgoMs == null || s.lastChunkAgoMs > limitMs) return { outage: true, why: "chunks stopped" };
  const levelKnown = s.levelReportedAgoMs != null && s.levelReportedAgoMs <= limitMs;
  if (!levelKnown) return { outage: false, why: "chunks flowing, level unknown" };
  if (s.nonzeroLevelAgoMs == null || s.nonzeroLevelAgoMs > limitMs) return { outage: true, why: "chunks flowing but level 0 (suspended audio)" };
  return { outage: false, why: "chunks flowing with level (quiet radio is fine)" };
}

export type RecoverGate = { allow: true } | { allow: false; why: string };

/** Watchdog-side guard before POSTing /api/capture/recover (mirror in watchdog.ps1). */
export function mayRequestRecover(input: {
  now: number;
  lastAppRestartAt: number;
  lastCodeUpdateAt: number;
  liveTabs: number;
  prevLiveTabs: number | null;
  recentRecoverTimes: number[];
  cooldownMs?: number;
  maxPerHour?: number;
}): RecoverGate {
  const cooldown = input.cooldownMs ?? RECOVER_COOLDOWN_MS;
  const cap = input.maxPerHour ?? MAX_RECOVERS_PER_HOUR;
  if (input.now - input.lastAppRestartAt < cooldown) return { allow: false, why: "cooldown after app restart" };
  if (input.now - input.lastCodeUpdateAt < cooldown) return { allow: false, why: "cooldown after code pull" };
  if (input.liveTabs > 1 && input.prevLiveTabs != null && input.liveTabs > input.prevLiveTabs) return { allow: false, why: "live tabs growing" };
  const lastHour = input.recentRecoverTimes.filter((t) => input.now - t < 60 * 60_000);
  if (lastHour.length >= cap) return { allow: false, why: "hourly recover cap reached" };
  return { allow: true };
}
