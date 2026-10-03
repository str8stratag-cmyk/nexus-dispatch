// Unit tests for the capture self-healing policy (2026-10-03).
// Run: npx tsx trial/test-capture-supervisor.ts
import {
  AUTO_CAPTURE_KEY,
  readAutoCapture,
  writeAutoCapture,
  startBackoffMs,
  stallThresholdMs,
  isStalled,
  shouldForceReload,
  MIN_FORCED_RELOAD_GAP_MS,
  readLastForcedReload,
  writeLastForcedReload,
  isPermissionError,
} from "../client/src/lib/capture-supervisor";
import { crashReloadDelayMs } from "../client/src/components/error-boundary";
import { isHmrEnabled } from "../server/vite";

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}: ${name}${ok ? "" : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`);
}

function memStorage(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (k: string) => (k in data ? data[k] : null),
    setItem: (k: string, v: string) => { data[k] = v; },
  };
}
const throwingStorage = {
  getItem: () => { throw new Error("denied"); },
  setItem: () => { throw new Error("denied"); },
};

// Auto-capture intent: ON by default (desks that never had the key keep the
// old auto-start-on-load behaviour), OFF only after an explicit Stop.
check("unset key = auto-capture on", readAutoCapture(memStorage()), true);
check("no storage = on", readAutoCapture(undefined), true);
check("throwing storage = on", readAutoCapture(throwingStorage), true);
check("explicit off", readAutoCapture(memStorage({ [AUTO_CAPTURE_KEY]: "off" })), false);
check("explicit on", readAutoCapture(memStorage({ [AUTO_CAPTURE_KEY]: "on" })), true);
{
  const s = memStorage();
  writeAutoCapture(s, false);
  check("write off persists", readAutoCapture(s), false);
  writeAutoCapture(s, true);
  check("write on persists", readAutoCapture(s), true);
  writeAutoCapture(throwingStorage, false); // must not throw
  check("write to throwing storage is swallowed", true, true);
}

// Backoff: immediate first try, then 2s doubling, capped at 60s, never gives up.
check("backoff 0 failures", startBackoffMs(0), 0);
check("backoff 1", startBackoffMs(1), 2_000);
check("backoff 2", startBackoffMs(2), 4_000);
check("backoff 3", startBackoffMs(3), 8_000);
check("backoff capped", startBackoffMs(10), 60_000);
check("backoff huge stays capped", startBackoffMs(10_000), 60_000);
check("backoff NaN", startBackoffMs(Number.NaN), 0);

// Stall detection keys off recorder chunks (silent chunks count), not POSTs.
check("stall threshold 4s chunks", stallThresholdMs(4_000), 20_000);
check("stall threshold 15s chunks", stallThresholdMs(15_000), 50_000);
const t0 = 1_000_000;
check("not capturing is never stalled", isStalled({ startedAt: 0, lastChunkAt: 0 }, t0 + 999_999, 4_000), false);
check("fresh start within grace", isStalled({ startedAt: t0, lastChunkAt: 0 }, t0 + 19_000, 4_000), false);
check("no chunk since start past threshold", isStalled({ startedAt: t0, lastChunkAt: 0 }, t0 + 21_000, 4_000), true);
check("recent chunk = healthy", isStalled({ startedAt: t0, lastChunkAt: t0 + 60_000 }, t0 + 64_000, 4_000), false);
check("chunks stopped = stalled", isStalled({ startedAt: t0, lastChunkAt: t0 + 60_000 }, t0 + 81_000, 4_000), true);
check("background throttling: 60s timer gap tolerates 64s without a chunk", isStalled({ startedAt: t0, lastChunkAt: t0 + 60_000 }, t0 + 124_000, 4_000, 60_000), false);
check("background throttling: still catches a real stall", isStalled({ startedAt: t0, lastChunkAt: t0 + 60_000 }, t0 + 211_000, 4_000, 60_000), true);
check("on-time 2s ticks keep the tight threshold", isStalled({ startedAt: t0, lastChunkAt: t0 + 60_000 }, t0 + 81_000, 4_000, 2_000), true);
check("stale chunk from previous session ignored", isStalled({ startedAt: t0 + 100_000, lastChunkAt: t0 }, t0 + 110_000, 4_000), false);

// Last-resort reload: needs repeated failures, 3+ min unhealthy, and rate limit.
const now = 50_000_000;
check("reload: too few recoveries", shouldForceReload({ now, recoveriesSinceHealthy: 3, unhealthySince: now - 600_000, lastForcedReloadAt: 0 }), false);
check("reload: not unhealthy long enough", shouldForceReload({ now, recoveriesSinceHealthy: 9, unhealthySince: now - 120_000, lastForcedReloadAt: 0 }), false);
check("reload: healthy (unhealthySince 0)", shouldForceReload({ now, recoveriesSinceHealthy: 9, unhealthySince: 0, lastForcedReloadAt: 0 }), false);
check("reload: qualifies", shouldForceReload({ now, recoveriesSinceHealthy: 4, unhealthySince: now - 181_000, lastForcedReloadAt: 0 }), true);
check("reload: rate limited", shouldForceReload({ now, recoveriesSinceHealthy: 9, unhealthySince: now - 600_000, lastForcedReloadAt: now - MIN_FORCED_RELOAD_GAP_MS + 1 }), false);
check("reload: allowed after gap", shouldForceReload({ now, recoveriesSinceHealthy: 9, unhealthySince: now - 600_000, lastForcedReloadAt: now - MIN_FORCED_RELOAD_GAP_MS - 1 }), true);
{
  const s = memStorage();
  check("last reload default 0", readLastForcedReload(s), 0);
  writeLastForcedReload(s, 12345);
  check("last reload round-trip", readLastForcedReload(s), 12345);
  check("last reload throwing storage", readLastForcedReload(throwingStorage), 0);
}

// Permission errors back off slowly instead of hammering getUserMedia.
check("NotAllowedError", isPermissionError({ name: "NotAllowedError", message: "x" }), true);
check("SecurityError", isPermissionError({ name: "SecurityError" }), true);
check("permission message", isPermissionError(new Error("Permission denied")), true);
check("NotReadableError is retryable", isPermissionError({ name: "NotReadableError", message: "Could not start audio source" }), false);
check("null", isPermissionError(null), false);

// Error-boundary reload backoff.
check("crash reload 0", crashReloadDelayMs(0), 15_000);
check("crash reload 1", crashReloadDelayMs(1), 30_000);
check("crash reload capped", crashReloadDelayMs(8), 300_000);
check("crash reload negative", crashReloadDelayMs(-3), 15_000);

// Desk mode: HMR socket off unless explicitly enabled.
check("HMR default off", isHmrEnabled({} as NodeJS.ProcessEnv), false);
check("HMR DM_HMR=1", isHmrEnabled({ DM_HMR: "1" } as NodeJS.ProcessEnv), true);
check("HMR DM_HMR=true", isHmrEnabled({ DM_HMR: "true" } as NodeJS.ProcessEnv), true);
check("HMR DM_HMR=0", isHmrEnabled({ DM_HMR: "0" } as NodeJS.ProcessEnv), false);

console.log(failures ? `${failures} FAILURES` : "all capture-supervisor tests passed");
process.exit(failures ? 1 : 0);
