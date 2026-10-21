// Reproduces the 2026-10-21 DISP-5 recover storm and shows the fix.
// Run: npx tsx trial/test-recover-storm.ts
import {
  CAPTURE_RECOVER_TTL_MS,
  CAPTURE_RECOVER_MIN_GAP_MS,
  RECOVER_COOLDOWN_MS,
  shouldDeliverRecover,
  acceptRecoverRequest,
  classifyCaptureOutage,
  mayRequestRecover,
} from "../shared/capture-recover";

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}: ${name}${ok ? "" : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`);
}

// --- Simulated desk: tabs heartbeat; a told tab reloads into a NEW tab id that
// first heartbeats ~5 s later. Old pages linger (Chrome kept them), so "live"
// grows with every reload, as on DISP-5 (58 -> 139+ tabs).
type Deliver = (i: { requestedAt: number; ttlMs: number; now: number; tabFirstSeenAt: number; toldAt: number }) => boolean;
// Pre-fix server rule (b9caa99 / d0ed149): any tab id not told since the request.
const oldDeliver: Deliver = (i) => !!i.requestedAt && i.now - i.requestedAt < i.ttlMs && i.toldAt < i.requestedAt;

function simulate(deliver: Deliver): { reloads: number; tabs: number } {
  const requestedAt = 1_000_000;
  const firstSeen = new Map<string, number>([["T0", requestedAt - 60_000]]);
  const told = new Map<string, number>();
  let queue: Array<{ id: string; at: number }> = [{ id: "T0", at: requestedAt + 1_000 }];
  let reloads = 0;
  let n = 0;
  while (queue.length) {
    const beat = queue.shift()!;
    if (beat.at - requestedAt > CAPTURE_RECOVER_TTL_MS + 60_000) break;
    if (!firstSeen.has(beat.id)) firstSeen.set(beat.id, beat.at);
    if (deliver({ requestedAt, ttlMs: CAPTURE_RECOVER_TTL_MS, now: beat.at, tabFirstSeenAt: firstSeen.get(beat.id)!, toldAt: told.get(beat.id) ?? 0 })) {
      told.set(beat.id, beat.at);
      reloads++;
      queue.push({ id: `T${++n}`, at: beat.at + 5_000 }); // reloaded page, new tab id
    } else {
      queue.push({ id: beat.id, at: beat.at + 60_000 }); // steady heartbeat
    }
    queue.sort((a, b) => a.at - b.at);
  }
  return { reloads, tabs: firstSeen.size };
}

const before = simulate(oldDeliver);
check("REPRO: old rule reloads every fresh tab (storm, dozens of reloads)", before.reloads > 50, true);
console.log(`      old rule: ${before.reloads} reloads, ${before.tabs} tab ids in 5 min`);
const after = simulate(shouldDeliverRecover);
check("FIX: exactly one reload per recover request", after.reloads, 1);
check("FIX: one new tab id (the reload)", after.tabs, 2);

// Once per pre-existing tab.
const r = { requestedAt: 10_000, ttlMs: CAPTURE_RECOVER_TTL_MS };
check("pre-existing tab told", shouldDeliverRecover({ ...r, now: 11_000, tabFirstSeenAt: 1_000, toldAt: 0 }), true);
check("not told twice", shouldDeliverRecover({ ...r, now: 12_000, tabFirstSeenAt: 1_000, toldAt: 11_000 }), false);
check("tab first seen after request not told", shouldDeliverRecover({ ...r, now: 12_000, tabFirstSeenAt: 10_500, toldAt: 0 }), false);
check("tab first seen at request instant not told", shouldDeliverRecover({ ...r, now: 12_000, tabFirstSeenAt: 10_000, toldAt: 0 }), false);
check("expired request", shouldDeliverRecover({ ...r, now: 10_000 + CAPTURE_RECOVER_TTL_MS, tabFirstSeenAt: 0, toldAt: 0 }), false);

// Server-side request guard: one pending request, min gap.
check("first request accepted", acceptRecoverRequest({ lastAcceptedAt: 0, now: 5 }), { accepted: true });
check("while pending ignored", acceptRecoverRequest({ lastAcceptedAt: 1_000, now: 1_000 + 60_000 }), { accepted: false, reason: "pending" });
check("after TTL but inside gap ignored", acceptRecoverRequest({ lastAcceptedAt: 1_000, now: 1_000 + CAPTURE_RECOVER_TTL_MS + 1 }), { accepted: false, reason: "too-soon" });
check("after gap accepted", acceptRecoverRequest({ lastAcceptedAt: 1_000, now: 1_000 + CAPTURE_RECOVER_MIN_GAP_MS }), { accepted: true });

// Outage rule. DISP-5 at 12:57: one tab, chunks flowing, sent=0 (quiet), level never reported (old bundle).
const lim = 5 * 60_000;
const base = { uptimeMs: 10 * 60_000, liveTabs: 1, wantingTabs: 1, lastChunkAgoMs: 5_000, levelReportedAgoMs: null, nonzeroLevelAgoMs: null };
check("REPRO case: quiet radio + old bundle is NOT an outage", classifyCaptureOutage(base, lim).outage, false);
check("quiet radio with level > 0 is NOT an outage", classifyCaptureOutage({ ...base, levelReportedAgoMs: 30_000, nonzeroLevelAgoMs: 30_000 }, lim).outage, false);
check("chunks with reported level 0 (suspended) IS an outage", classifyCaptureOutage({ ...base, levelReportedAgoMs: 30_000, nonzeroLevelAgoMs: null }, lim), { outage: true, why: "chunks flowing but level 0 (suspended audio)" });
check("level 0 for > limit IS an outage", classifyCaptureOutage({ ...base, levelReportedAgoMs: 30_000, nonzeroLevelAgoMs: lim + 1 }, lim).outage, true);
check("chunks stopped IS an outage", classifyCaptureOutage({ ...base, lastChunkAgoMs: lim + 1 }, lim), { outage: true, why: "chunks stopped" });
check("never any chunk IS an outage", classifyCaptureOutage({ ...base, lastChunkAgoMs: null }, lim).outage, true);
check("just booted: not yet", classifyCaptureOutage({ ...base, uptimeMs: 60_000, lastChunkAgoMs: null }, lim).outage, false);
check("no live tab: not this check", classifyCaptureOutage({ ...base, liveTabs: 0, lastChunkAgoMs: null }, lim).outage, false);
check("operator Stop: not an outage", classifyCaptureOutage({ ...base, wantingTabs: 0, lastChunkAgoMs: null }, lim).outage, false);

// Watchdog gate.
const now = 100 * 60_000;
const g = { now, lastAppRestartAt: 0, lastCodeUpdateAt: 0, liveTabs: 1, prevLiveTabs: null, recentRecoverTimes: [] as number[] };
check("gate: normal outage allowed", mayRequestRecover(g), { allow: true });
check("gate: cooldown after app restart", mayRequestRecover({ ...g, lastAppRestartAt: now - RECOVER_COOLDOWN_MS + 1 }), { allow: false, why: "cooldown after app restart" });
check("gate: cooldown after code pull", mayRequestRecover({ ...g, lastCodeUpdateAt: now - 60_000 }), { allow: false, why: "cooldown after code pull" });
check("gate: tabs growing (storm in progress)", mayRequestRecover({ ...g, liveTabs: 58, prevLiveTabs: 12 }), { allow: false, why: "live tabs growing" });
check("gate: two steady tabs allowed", mayRequestRecover({ ...g, liveTabs: 2, prevLiveTabs: 2 }), { allow: true });
check("gate: hourly cap", mayRequestRecover({ ...g, recentRecoverTimes: [now - 50 * 60_000, now - 30 * 60_000, now - 10 * 60_000] }), { allow: false, why: "hourly recover cap reached" });
check("gate: old recovers age out", mayRequestRecover({ ...g, recentRecoverTimes: [now - 3 * 60 * 60_000] }), { allow: true });

console.log(failures ? `${failures} FAILURES` : "all recover-storm tests passed");
process.exit(failures ? 1 : 0);
