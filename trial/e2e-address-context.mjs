// E2E for address-from-context + intake counters against a LOCAL app.
// Never point this at a production DB. Usage:
//   MONGODB_URI=mongodb://127.0.0.1:27555/ MONGODB_DB_NAME=e2e PORT=5055 npx tsx server/index.ts &
//   BASE=http://127.0.0.1:5055 node trial/e2e-address-context.mjs   (use a FRESH db name per run: dedup remembers earlier addresses)
const BASE = process.env.BASE || "http://127.0.0.1:5055";
if (!/127\.0\.0\.1|localhost/.test(BASE)) throw new Error("refusing to run against a non-local app");
let fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(ok ? "ok  :" : "FAIL:", label, ok ? "" : `| got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
};
const post = async (body) => {
  const r = await fetch(`${BASE}/api/dispatch`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const health = async () => (await (await fetch(`${BASE}/api/health`)).json()).dispatch;
const mk = (over) => ({
  transcript: "signal 4 on", keywords: JSON.stringify([{ keyword: "signal 4", signalType: "Signal 4" }]),
  address: null, crossStreet: null, lat: null, lng: null, signalType: "Signal 4", description: "Signal 4",
  district: "TEST", source: "e2e-" + Math.random().toString(36).slice(2, 7), status: "active", isManual: false, ...over,
});
const now = Date.now();

const h0 = await health();

// 1. context recovery
let r = await post(mk({ contextTranscripts: ["units are clear", "4500 West Kennedy Boulevard"], clientRequestId: "e2e-1-" + now, audioStartedAt: now - 8000, audioEndedAt: now - 2000 }));
console.log("  ->", r.status, JSON.stringify(r.body).slice(0, 300));
check("context recovery: created", r.status, 201);
check("context recovery: address filled + flagged", [r.body.address, r.body.addressFromContext], ["4500 West Kennedy Blvd", true]);
check("context recovery: intake-only fields not stored", [r.body.contextTranscripts, r.body.clientRequestId], [undefined, undefined]);
check("chunk times persisted as ISO", [typeof r.body.audioStartedAt, typeof r.body.audioEndedAt], ["string", "string"]);

// 2. repeated clientRequestId is ignored
r = await post(mk({ contextTranscripts: ["4500 West Kennedy Boulevard"], clientRequestId: "e2e-1-" + now }));
check("repeated clientRequestId: ignored", [r.status, r.body.duplicate, r.body.repeatedRequest], [200, true, true]);

// 3. no-context control
r = await post(mk({}));
check("no context: rejected as before", [r.status, /resolved address/.test(r.body.message || "")], [400, true]);

// 4. inline address regression; client cannot forge the flag
r = await post(mk({ transcript: "signal 4 at 1500 North Dale Mabry Highway", address: "1500 North Dale Mabry Highway", addressFromContext: true }));
console.log("  ->", r.status, JSON.stringify(r.body).slice(0, 200));
check("inline address: created, addressFromContext forced false", [r.status, r.body.addressFromContext], [201, false]);

// 5. production-audio context cannot supply an address
r = await post(mk({ contextTranscripts: ["this is a production of 2100 East Hillsborough Avenue"] }));
check("production-audio context: rejected", r.status, 400);

// 6. ambiguous context (two different addresses)
r = await post(mk({ contextTranscripts: ["4500 West Kennedy Boulevard", "3000 West Gandy Boulevard"] }));
check("ambiguous context: rejected", r.status, 400);

// 7. context never rescues a manual-flag-less call whose context carries another call
r = await post(mk({ contextTranscripts: ["tow truck at 2100 East Hillsborough Avenue"] }));
check("other call's chunk as context: rejected", r.status, 400);

// 8. kill switch is env-based (DM_ADDRESS_CONTEXT=off) -- not toggled here; covered by unit tests.

// 9. counters: every rejection has exactly one quarantine outcome
const h1 = await health();
check("counters: rejected == quarantined + failed (delta)", h1.rejected - h0.rejected, (h1.quarantined - h0.quarantined) + (h1.quarantineFailed - h0.quarantineFailed));
check("counters: rejections observed", h1.rejected - h0.rejected, 4);
check("counters: context saves", h1.addressContextSaves - h0.addressContextSaves, 1);
check("counters: repeated request id", h1.repeatRequestIdsIgnored - h0.repeatRequestIdsIgnored, 1);

// 10. zod 400 counted
r = await post({ transcript: 5 });
check("zod error counted", [r.status, (await health()).zod400 - h0.zod400], [400, 1]);

// 11. quarantine docs carry chunk-time + context fields
const q = await (await fetch(`${BASE}/api/quarantine`)).json().catch(() => null);
console.log("  quarantine list sample:", JSON.stringify(Array.isArray(q) ? q[0] : q).slice(0, 300));

console.log(fail === 0 ? "ALL PASS" : `${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
