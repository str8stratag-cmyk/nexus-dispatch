// Capture auto-resume after an app restart (2026-10-21, DISP-1 11:35-11:40).
// Run: npx tsx trial/test-capture-resume.ts
import {
  decideLease,
  confirmLease,
  minuteShowsAudio,
  minuteLevel,
  UNCONFIRMED_LEASE_GRACE_MS,
  UNCONFIRMED_CAPTURING_GRACE_MS,
  LEASE_TTL_MS,
} from "../shared/capture-lease";

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}: ${name}${ok ? "" : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`);
}

const t0 = 1_800_000_000_000;

// Boot: the leftover pre-restart tab asks first and gets an UNCONFIRMED lease.
const stale = decideLease(null, { tabId: "OLD", capturing: false }, t0);
check("boot: first asker granted", stale.granted, true);
check("boot: lease starts unconfirmed", stale.lease?.confirmed, false);
check("boot: grantedAt stamped", stale.lease?.grantedAt, t0);

// The new watchdog tab asks inside the grace: denied (no flapping).
check("new tab denied inside grace", decideLease(stale.lease, { tabId: "NEW", capturing: false }, t0 + 10_000).granted, false);

// The old tab keeps renewing but never shows audio: renewal keeps it unconfirmed.
const renewed = decideLease(stale.lease, { tabId: "OLD", capturing: false }, t0 + 30_000).lease;
check("renewal keeps unconfirmed", renewed?.confirmed, false);
check("renewal keeps grantedAt", renewed?.grantedAt, t0);

// After the grace, ANY other tab may take an unconfirmed lease (even not yet capturing).
const takeover = decideLease(renewed, { tabId: "NEW", capturing: false }, t0 + UNCONFIRMED_LEASE_GRACE_MS + 1);
check("unconfirmed lease taken over after grace", takeover.granted, true);
check("new holder", takeover.lease?.tabId, "NEW");
check("new holder starts unconfirmed", takeover.lease?.confirmed, false);

// A heartbeat with real audio from the holder confirms it; then it is protected.
const confirmed = confirmLease(takeover.lease, "NEW", true);
check("holder confirmed by audio", confirmed?.confirmed, true);
check("confirm ignores other tabs", confirmLease(takeover.lease, "OLD", true)?.confirmed, false);
check("confirm ignores silent minute", confirmLease(takeover.lease, "NEW", false)?.confirmed, false);
const later = t0 + UNCONFIRMED_LEASE_GRACE_MS + 120_000;
const renewedConfirmed = decideLease(confirmed, { tabId: "NEW", capturing: true }, later - 60_000).lease;
check("confirmed survives renewal", renewedConfirmed?.confirmed, true);
check("confirmed holder not displaced", decideLease(renewedConfirmed, { tabId: "OTHER", capturing: false }, later).granted, false);

// An unconfirmed holder that CLAIMS to capture gets ~3 heartbeats to show audio
// (heartbeats are 60 s apart, so a real capturer is never displaced before its first beat).
const capHolder = decideLease(null, { tabId: "CAP", capturing: true }, t0).lease;
check("capturing unconfirmed holder kept past idle grace", decideLease(capHolder, { tabId: "X", capturing: true }, t0 + 120_000).granted, false);
check("capturing unconfirmed holder with no audio yields eventually", decideLease(capHolder, { tabId: "X", capturing: true }, t0 + UNCONFIRMED_CAPTURING_GRACE_MS).granted, true);
check("capturing grace covers 3 heartbeats", UNCONFIRMED_CAPTURING_GRACE_MS > 3 * 60_000, true);

// Old-format lease (no confirmed field) is treated as confirmed.
check("legacy lease not displaced", decideLease({ tabId: "L", expiresAt: t0 + LEASE_TTL_MS }, { tabId: "X", capturing: false }, t0 + 100_000).granted, false);

// Real-activity test used for confirmation and the watchdog.
check("sent>0 = audio", minuteShowsAudio({ chunksSent: 3, chunksRecorded: 10, levelPeak: 0 }), true);
check("silent gated minute with level = audio", minuteShowsAudio({ chunksSent: 0, chunksRecorded: 10, levelPeak: 0.004 }), true);
check("suspended context: chunks but zero level = no audio", minuteShowsAudio({ chunksSent: 0, chunksRecorded: 10, levelPeak: 0 }), false);
check("no chunks = no audio", minuteShowsAudio({ chunksSent: 0, chunksRecorded: 0, levelPeak: null }), false);
check("missing minute = no audio", minuteShowsAudio(null), false);

check("minuteLevel avg/peak", minuteLevel(4, 0.2, 0.09), { levelAvg: 0.05, levelPeak: 0.09 });
check("minuteLevel no chunks", minuteLevel(0, 0, 0), { levelAvg: null, levelPeak: null });
check("minuteLevel clamps", minuteLevel(1, 5, 3), { levelAvg: 1, levelPeak: 1 });

console.log(failures ? `${failures} FAILURES` : "all capture-resume tests passed");
process.exit(failures ? 1 : 0);
