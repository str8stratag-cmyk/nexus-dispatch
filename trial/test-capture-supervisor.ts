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
import {
  decideLease,
  releaseLease,
  LEASE_TTL_MS,
  LEASE_IDLE_GRACE_MS,
  HOLDER_IDLE_GRACE_MS,
  decideTabAction,
  mayRunCapture,
  summarizeDesk,
  pruneTabs,
  TAB_FORGET_MS,
  type TabSnapshot,
  type TabHeartbeat,
} from "../shared/capture-lease";

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

// Per-box capture lease: one capturing tab across origins.
{
  const later = 100_000;
  let d = decideLease(null, { tabId: "A", capturing: false }, later);
  check("lease: first claimant after grace wins", d.granted, true);
  const leaseA = d.lease;
  d = decideLease(leaseA, { tabId: "B", capturing: false }, later + 1_000);
  check("lease: second tab denied", d.granted, false);
  check("lease: holder unchanged", d.lease?.tabId, "A");
  d = decideLease(leaseA, { tabId: "B", capturing: true }, later + 1_000);
  check("lease: second tab denied even if capturing", d.granted, false);
  d = decideLease(leaseA, { tabId: "A", capturing: true }, later + 10_000);
  check("lease: holder renews", d.granted && d.lease?.expiresAt === later + 10_000 + LEASE_TTL_MS, true);
  d = decideLease(leaseA, { tabId: "B", capturing: false }, later + LEASE_TTL_MS + 1);
  check("lease: expired lease taken over", d.granted && d.lease?.tabId === "B", true);
  d = decideLease(leaseA, { tabId: "B", capturing: false, force: true }, later + 1_000);
  check("lease: Start pressed (force) takes over", d.granted && d.lease?.tabId === "B", true);
  d = decideLease(null, { tabId: "B", capturing: false }, 10_000);
  check("lease: after restart, a lone fresh page is granted at once", d.granted, true);
  d = decideLease(d.lease, { tabId: "A", capturing: true }, 12_000);
  check("lease: ...and the old capturer is then denied (single capturer)", d.granted, false);
  d = decideLease(null, { tabId: "", capturing: true }, later);
  check("lease: empty tab id refused", d.granted, false);
  check("lease: release by holder", releaseLease(leaseA, "A"), null);
  check("lease: release by other tab ignored", releaseLease(leaseA, "B")?.tabId, "A");
}

// DISP-1 2026-10-20: tab A holds lock+lease but is idle, tab B captures in standby.
{
  const t0 = 5_000_000;
  let d = decideLease(null, { tabId: "A", capturing: false }, t0);
  const idleA = d.lease;
  check("idle lease: holder records idleSince", idleA?.idleSince, t0);
  d = decideLease(idleA, { tabId: "A", capturing: false }, t0 + 15_000);
  check("idle lease: renewal keeps original idleSince", d.lease?.idleSince, t0);
  d = decideLease(d.lease, { tabId: "B", capturing: true }, t0 + LEASE_IDLE_GRACE_MS - 1);
  check("idle lease: capturing tab waits out the grace", d.granted, false);
  d = decideLease(d.lease, { tabId: "B", capturing: true }, t0 + LEASE_IDLE_GRACE_MS);
  check("idle lease: capturing tab takes over an idle holder", d.granted && d.lease?.tabId === "B", true);
  check("idle lease: new holder marked capturing", d.lease?.capturing === true && d.lease?.idleSince === null, true);
  const capB = d.lease;
  d = decideLease(capB, { tabId: "A", capturing: false }, t0 + LEASE_IDLE_GRACE_MS + 100_000);
  check("idle lease: idle tab can't take a capturing holder's lease", d.granted, false);
  d = decideLease(capB, { tabId: "A", capturing: true }, t0 + LEASE_IDLE_GRACE_MS + 100_000);
  check("idle lease: capturing holder is never displaced by another capturer", d.granted, false);
  d = decideLease({ tabId: "A", expiresAt: t0 + LEASE_TTL_MS }, { tabId: "B", capturing: true }, t0 + 60_000);
  check("idle lease: old-format lease (no capturing field) not displaced", d.granted, false);

  const base: TabSnapshot = { lock: "held", lease: "granted", capturing: false, autoCapture: true, micPermission: "granted", idleHolderSince: t0, now: t0 };
  check("tab: capturing holder does nothing", decideTabAction({ ...base, capturing: true }), "none");
  check("tab: idle holder within grace waits (auto-start)", decideTabAction({ ...base, now: t0 + HOLDER_IDLE_GRACE_MS - 1 }), "none");
  check("tab: idle holder, lease denied -> yield", decideTabAction({ ...base, lease: "denied", now: t0 + HOLDER_IDLE_GRACE_MS }), "yield");
  check("tab: idle holder, mic prompt -> yield", decideTabAction({ ...base, micPermission: "prompt", now: t0 + HOLDER_IDLE_GRACE_MS }), "yield");
  check("tab: idle holder, mic denied -> yield", decideTabAction({ ...base, micPermission: "denied", now: t0 + HOLDER_IDLE_GRACE_MS }), "yield");
  check("tab: idle holder w/ permission keeps trying briefly", decideTabAction({ ...base, now: t0 + 2 * HOLDER_IDLE_GRACE_MS }), "none");
  check("tab: idle holder w/ permission yields eventually", decideTabAction({ ...base, now: t0 + 3 * HOLDER_IDLE_GRACE_MS }), "yield");
  check("tab: Stop pressed holder yields", decideTabAction({ ...base, autoCapture: false }), "yield");
  check("tab: capturing tab with lease elsewhere stops", decideTabAction({ ...base, lock: "standby", lease: "denied", capturing: true }), "stop");
  check("tab: capturing standby tab keeps going", decideTabAction({ ...base, lock: "standby", capturing: true }), "none");
  check("run: standby + capturing + lease granted may heal capture", mayRunCapture("standby", "granted", true), true);
  check("run: standby not capturing may not start", mayRunCapture("standby", "granted", false), false);
  check("run: standby capturing, lease unknown -> no", mayRunCapture("standby", "unknown", true), false);
  check("run: holder may run", mayRunCapture("held", "unknown", false), true);
  check("run: lease denied never runs", mayRunCapture("held", "denied", false), false);

  const now = t0 + 1_000_000;
  const tab = (id: string, agoMs: number, capturing: boolean, chunkAgo: number | null): TabHeartbeat => ({
    tabId: id, at: now - agoMs, origin: null, capturing, lock: null, lease: null,
    lastChunkAt: chunkAgo == null ? null : now - chunkAgo, lastSentAt: null,
  });
  let sum = summarizeDesk([tab("A", 10_000, false, null), tab("B", 30_000, true, 34_000)], now, 150_000);
  check("desk: capturing if any live tab captures (not last beat wins)", [sum.effectiveCapturing, sum.liveTabs, sum.capturingTabs, sum.lastChunkAgoMs], [true, 2, 1, 34_000]);
  sum = summarizeDesk([tab("A", 10_000, false, null), tab("B", 30_000, true, 400_000)], now, 150_000);
  check("desk: capturing tab with stale chunks is not effectively capturing", sum.effectiveCapturing, false);
  sum = summarizeDesk([tab("B", 200_000, true, 1_000)], now, 150_000);
  check("desk: stale tab not counted live", [sum.liveTabs, sum.effectiveCapturing], [0, false]);
  const m = new Map([["A", tab("A", TAB_FORGET_MS + 1, false, null)], ["B", tab("B", 1, true, 1)]]);
  pruneTabs(m, now);
  check("desk: long-silent tabs pruned", Array.from(m.keys()), ["B"]);
}

console.log(failures ? `${failures} FAILURES` : "all capture-supervisor tests passed");
process.exit(failures ? 1 : 0);
