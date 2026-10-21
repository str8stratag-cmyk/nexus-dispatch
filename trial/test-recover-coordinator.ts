// Simulated server + tabs for the 2026-10-21 DISP-5 fix (single-target recover,
// 30-min persisted gap, no reload while pending, dead-lock-holder takeover).
// Run: npx tsx trial/test-recover-coordinator.ts
import {
  RecoverCoordinator,
  memoryStore,
  RECOVER_MIN_GAP_MS,
  DEAD_HOLDER_MS,
  type CoordTab,
} from "../shared/capture-recover-coordinator";
import { decideLease, DEAD_HOLDER_LEASE_MS, type CaptureLease } from "../shared/capture-lease";
import { classifyCaptureOutage } from "../shared/capture-recover";

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}: ${name}${ok ? "" : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`);
}
const quiet = () => undefined;

// ---- Simulated desk -------------------------------------------------------
// A reloaded tab gets a NEW id and (worst case, as on DISP-5) sits at
// lock=pending because the dead old page still owns the Web Lock.
class Desk {
  tabs = new Map<string, CoordTab>();
  reloads = 0;
  n = 0;
  constructor(public coord: RecoverCoordinator) {}
  add(id: string, now: number, lock: string, capturing = false, lastChunkAt: number | null = null) {
    this.tabs.set(id, { tabId: id, at: now, firstSeenAt: now, lock, capturing, lastChunkAt });
  }
  beat(id: string, now: number) {
    const t = this.tabs.get(id)!;
    t.at = now;
    const reply = this.coord.onHeartbeat(id, this.tabs.values(), now);
    if (reply.recover) {
      this.reloads++;
      // Old page stays around (dead, silent) holding the lock; new page pending.
      t.at = now - 1; // its last beat
      const nid = `R${++this.n}`;
      this.add(nid, now + 5_000, "pending");
    }
    return reply;
  }
}

const T = 1_800_000_000_000;

// 1. No storm under repeated outages: watchdog asks every loop (30 s) for 2 h.
{
  const store = memoryStore();
  const desk = new Desk(new RecoverCoordinator(store, quiet));
  desk.add("T0", T - 60_000, "held", true, T - 6 * 60_000);
  let accepted = 0;
  for (let now = T; now < T + 2 * 3600_000; now += 30_000) {
    if (desk.coord.request(desk.tabs.values(), now).accepted) accepted++;
    // every live (non-dead) tab heartbeats each minute
    if ((now - T) % 60_000 === 0) for (const id of Array.from(desk.tabs.keys())) if (id !== "T0" || desk.reloads === 0) desk.beat(id, now);
  }
  check("storm: at most one accepted recover while a pending tab exists (2 h of requests)", accepted, 1);
  check("storm: exactly one reload delivered", desk.reloads, 1);
  check("storm: tab count stays bounded (2 ids, not 100+)", desk.tabs.size, 2);
}

// 2. No reload while ANY live tab is pending (request refused, delivery withheld).
{
  const c = new RecoverCoordinator(memoryStore(), quiet);
  const tabs: CoordTab[] = [
    { tabId: "A", at: T, firstSeenAt: T - 600_000, lock: "held", capturing: false, lastChunkAt: null },
    { tabId: "B", at: T, firstSeenAt: T - 60_000, lock: "pending", capturing: false, lastChunkAt: null },
  ];
  check("pending: request refused", c.request(tabs, T), { accepted: false, reason: "tab-pending", pendingTabs: ["B"] });
  const c2 = new RecoverCoordinator(memoryStore(), quiet);
  const ok = c2.request([tabs[0]], T);
  check("pending: accepted with no pending tab -> single target", ok, { accepted: true, targetTabId: "A" });
  check("pending: delivery withheld once a tab turns pending", c2.onHeartbeat("A", tabs, T + 10_000).recover, undefined);
  check("pending: delivered when pending clears", c2.onHeartbeat("A", [tabs[0]], T + 20_000).recover, "reload");
  check("pending: never delivered twice", c2.onHeartbeat("A", [tabs[0]], T + 80_000).recover, undefined);
}

// 3. Cooldown: 30 min, persisted across a server restart; single target only.
{
  const store = memoryStore();
  const tabs: CoordTab[] = [
    { tabId: "A", at: T, firstSeenAt: T - 600_000, lock: "held", capturing: false, lastChunkAt: null },
    { tabId: "S", at: T - 5_000, firstSeenAt: T - 600_000, lock: "standby", capturing: false, lastChunkAt: null },
  ];
  const c = new RecoverCoordinator(store, quiet);
  check("cooldown: first accepted, targets lock holder", c.request(tabs, T), { accepted: true, targetTabId: "A" });
  check("cooldown: standby tab not told", c.onHeartbeat("S", tabs, T + 1_000).recover, undefined);
  check("cooldown: new tab id not told", c.onHeartbeat("NEW", [...tabs, { tabId: "NEW", at: T + 2_000, firstSeenAt: T + 2_000, lock: "standby", capturing: false, lastChunkAt: null }], T + 2_000).recover, undefined);
  const r = c.request(tabs, T + 10 * 60_000);
  check("cooldown: refused at +10 min", r.accepted ? "accepted" : r.reason, "cooldown");
  const restarted = new RecoverCoordinator(store, quiet); // app restart / code pull
  const r2 = restarted.request(tabs, T + 29 * 60_000);
  check("cooldown: persisted across server restart (+29 min refused)", r2.accepted ? "accepted" : r2.reason, "cooldown");
  check("cooldown: accepted again at +30 min", restarted.request(tabs.map((t) => ({ ...t, at: T + RECOVER_MIN_GAP_MS - 1_000 })), T + RECOVER_MIN_GAP_MS).accepted, true);
}

// 4. Dead lock holder: silent 5+ min -> ONE waiting tab told to steal the Web Lock; lease takeover.
{
  const c = new RecoverCoordinator(memoryStore(), quiet);
  const dead: CoordTab = { tabId: "D", at: T - DEAD_HOLDER_MS - 1, firstSeenAt: T - 3600_000, lock: "held", capturing: true, lastChunkAt: T - DEAD_HOLDER_MS - 1 };
  const p1: CoordTab = { tabId: "P1", at: T, firstSeenAt: T - 120_000, lock: "pending", capturing: false, lastChunkAt: null };
  const p2: CoordTab = { tabId: "P2", at: T, firstSeenAt: T - 60_000, lock: "standby", capturing: false, lastChunkAt: null };
  const freshHolder = { ...dead, at: T - 60_000, lastChunkAt: T - 4 * 60_000 };
  check("takeover: not while holder sent a heartbeat < 5 min ago", c.onHeartbeat("P1", [freshHolder, p1, p2], T).takeLock, undefined);
  check("takeover: dead holder -> first waiting tab takes the lock", c.onHeartbeat("P1", [dead, p1, p2], T).takeLock, true);
  check("takeover: only ONE tab told at a time", c.onHeartbeat("P2", [dead, p1, p2], T + 1_000).takeLock, undefined);
  check("takeover: another tab after 2 min if still no holder", c.onHeartbeat("P2", [dead, p1, p2], T + 121_000).takeLock, true);
  const st = c.status([dead, p1, p2], T);
  check("status: dead holder listed, 1 pending, 0 capturing", [st.deadLockHolders, st.pendingTabs, st.lockHeldCapturingTabs], [["D"], 1, 0]);
  // Lease held by the dead page (still renewing / not expired).
  const lease: CaptureLease = { tabId: "D", expiresAt: T + 100_000, capturing: true, idleSince: null, confirmed: true, grantedAt: T - 3600_000 };
  check("lease: live holder keeps lease", decideLease(lease, { tabId: "P1", capturing: false }, T, T - 60_000).granted, false);
  check("lease: dead holder (5+ min silent) loses lease", decideLease(lease, { tabId: "P1", capturing: false }, T, T - DEAD_HOLDER_LEASE_MS).granted, true);
  check("lease: unknown holder signal keeps old behaviour", decideLease(lease, { tabId: "P1", capturing: false }, T).granted, false);
}

// 4b. Outstanding recover is cleared once a tab captures with the lock held, and on browser restart.
{
  const c = new RecoverCoordinator(memoryStore(), quiet);
  const A: CoordTab = { tabId: "A", at: T, firstSeenAt: T - 600_000, lock: "held", capturing: false, lastChunkAt: null };
  c.request([A], T);
  check("clear: outstanding after accept", c.status([A], T).recover.outstanding, true);
  const N: CoordTab = { tabId: "N", at: T + 30_000, firstSeenAt: T + 25_000, lock: "held", capturing: true, lastChunkAt: T + 29_000 };
  check("clear: capturing lock holder -> no delivery to anyone", c.onHeartbeat("A", [A, N], T + 30_000).recover, undefined);
  check("clear: recover cleared", c.status([A, N], T + 30_000).recover.outstanding, false);
  check("clear: 30-min gap still enforced", (c.request([{ ...A, at: T + 60_000 }], T + 60_000) as { reason?: string }).reason, "cooldown");
  // Old 298a259 storm shape: many new tab ids heartbeating while recover outstanding -> none told.
  const c2 = new RecoverCoordinator(memoryStore(), quiet);
  c2.request([A], T);
  let told = 0;
  for (let i = 0; i < 50; i++) if (c2.onHeartbeat(`X${i}`, [A, { tabId: `X${i}`, at: T + i * 1000, firstSeenAt: T + i * 1000, lock: "standby", capturing: false, lastChunkAt: null }], T + i * 1000).recover) told++;
  check("storm shape: 50 new tab ids, zero re-deliveries", told, 0);
  c2.onBrowserRestarted();
  check("browser restart clears outstanding recover", c2.status([], T + 60_000).recover.outstanding, false);
}

// 5. Quiet / missing level is unknown, not an outage.
{
  const base = { uptimeMs: 3600_000, liveTabs: 1, wantingTabs: 1, lastChunkAgoMs: 4_000 };
  check("level missing -> not outage", classifyCaptureOutage({ ...base, levelReportedAgoMs: null, nonzeroLevelAgoMs: null }, 300_000).outage, false);
  check("level quiet (0) -> not outage", classifyCaptureOutage({ ...base, levelReportedAgoMs: 10_000, nonzeroLevelAgoMs: null }, 300_000).outage, false);
  check("chunks stopped -> outage", classifyCaptureOutage({ ...base, lastChunkAgoMs: 400_000, levelReportedAgoMs: null, nonzeroLevelAgoMs: null }, 300_000).outage, true);
}

console.log(failures ? `${failures} FAILURES` : "all recover-coordinator tests passed");
process.exit(failures ? 1 : 0);
