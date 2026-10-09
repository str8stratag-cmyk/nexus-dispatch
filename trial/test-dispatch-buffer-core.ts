/**
 * Pure tests for the dispatch buffer state machine (address hold + context).
 * Fake clock, no React, no network. Run: npx tsx trial/test-dispatch-buffer-core.ts
 */
import {
  DispatchBufferCore,
  isTrueRepeat,
  endsIncomplete,
  looksAddressy,
  incidentClass,
  type CorePayload,
} from "../client/src/lib/dispatch-buffer-core";
import { detectKeywords, DEFAULT_KEYWORDS } from "../shared/keywords";

let fail = 0;
function check(label: string, got: unknown, want: unknown) {
  const ok = Object.is(got, want) || JSON.stringify(got) === JSON.stringify(want);
  if (!ok) {
    fail++;
    console.log("FAIL:", label, "| got:", JSON.stringify(got), "| want:", JSON.stringify(want));
  } else {
    console.log("ok  :", label);
  }
}

let idSeq = 0;
function harness(overrides: Record<string, unknown> = {}) {
  const core = new DispatchBufferCore({
    detectKeywords: (t) => detectKeywords(t, DEFAULT_KEYWORDS),
    newId: () => `req-${++idSeq}`,
    ...overrides,
  });
  let t = 1_000_000;
  const out: CorePayload[] = [];
  const api = {
    core,
    out,
    now: () => t,
    /** A chunk arrives `afterMs` after the previous event; timers due before it fire first. */
    say(text: string, afterMs = 4000) {
      api.advance(afterMs);
      out.push(...core.push(text, t));
      return api;
    },
    /** Advance the clock, firing every deadline on the way. */
    advance(ms: number) {
      const target = t + ms;
      for (;;) {
        const d = core.nextDeadline();
        if (d === null || d > target) break;
        t = Math.max(t, d);
        out.push(...core.tick(t));
      }
      t = target;
      return api;
    },
    flush() {
      const p = core.flush(t);
      out.push(...p);
      return p;
    },
  };
  return api;
}

// --- baseline: inline address never waits -------------------------------------------
{
  const h = harness();
  h.say("signal 4 at 4500 West Kennedy Boulevard").advance(5000);
  check("inline address: exactly one dispatch after the 5s silence", h.out.length, 1);
  check("inline address: address extracted", h.out[0]?.address, "4500 West Kennedy Blvd");
  check("inline address: not held, no context", [h.out[0]?.addressHeld, h.out[0]?.contextTranscripts], [false, undefined]);
  check("inline address: returns to idle", h.core.getPhase(), "idle");
}

// --- keyword-free chatter never dispatches -------------------------------------------
{
  const h = harness();
  h.say("copy that unit twelve").say("ten four").advance(60_000);
  check("no keyword: nothing dispatched", h.out.length, 0);
  check("no keyword: nothing pending", h.core.isBusy(), false);
}

// --- ring pruning: 16 entries / 90 s -------------------------------------------------
{
  const h = harness();
  for (let i = 0; i < 20; i++) h.say(`chatter number ${i}`, 1000);
  check("ring capped at 16 entries", h.core.getRingTexts().length, 16);
  check("ring keeps the newest", h.core.getRingTexts()[15], "chatter number 19");
  h.advance(91_000);
  h.say("another chatter", 0);
  check("ring ages out entries older than 90 s", h.core.getRingTexts(), ["another chatter"]);
}

// --- hold decision + release on address + settle timer ------------------------------
{
  const h = harness();
  h.say("signal 4 on").advance(5000);
  check("keyword without address: not dispatched, held", [h.out.length, h.core.getPhase()], [0, "hold"]);
  check("hold counted", h.core.stats.holdsEntered, 1);
  h.say("4500 West Kennedy Boulevard", 6000);
  check("address arrives: not sent instantly (settle)", h.out.length, 0);
  h.advance(2900);
  check("still waiting just before the 3 s settle", h.out.length, 0);
  h.advance(200);
  check("settle elapsed: one dispatch", h.out.length, 1);
  const p = h.out[0];
  check("held call carries the full call text", p?.transcript, "signal 4 on 4500 West Kennedy Boulevard");
  check("held call has the address", p?.address, "4500 West Kennedy Blvd");
  check("held call flagged addressHeld, no context needed", [p?.addressHeld, p?.contextTranscripts], [true, undefined]);
  check("released by address counted", h.core.stats.holdsResolvedByAddress, 1);
  check("idle again", h.core.getPhase(), "idle");
}

// --- settle timer resets on a trailing fragment --------------------------------------
{
  const h = harness();
  h.say("signal 4 on").advance(5000);
  h.say("4500 West Kennedy", 5000);
  h.say("Boulevard", 2000); // inside the settle window
  h.advance(2900);
  check("settle restarted by trailing chunk", h.out.length, 0);
  h.advance(200);
  check("one dispatch with the complete address", [h.out.length, h.out[0]?.address], [1, "4500 West Kennedy Blvd"]);
}

// --- chunk-boundary split 'McKi' / 'nley' --------------------------------------------
{
  const h = harness();
  h.say("signal 4 at 1234 McKi").advance(5000);
  check("split word: first half has no address, held", [h.out.length, h.core.getPhase()], [0, "hold"]);
  h.say("nley Drive", 3000).advance(3100);
  check("split word: joined text dispatched once", h.out.length, 1);
  check("split word: pieces joined with a space (server dictionary fix then resolves McKinley)", h.out[0]?.transcript, "signal 4 at 1234 McKi nley Drive");
  check("split word: address spans both chunks", h.out[0]?.address, "1234 McKi nley Drive");
}

// --- hold timeout fallback ----------------------------------------------------------
{
  const h = harness();
  // Gaps > 10 s: older than the same-transmission lead-in, so they can only be context.
  h.say("how is the weather out there").say("units are clear of the scene", 12_000);
  h.say("signal 4 on", 12_000).advance(5000);
  check("timeout: held", h.core.getPhase(), "hold");
  h.advance(39_000);
  check("timeout: still waiting at 39 s of hold", h.out.length, 0);
  h.advance(2000);
  check("timeout: dispatched once as-is", h.out.length, 1);
  const p = h.out[0];
  check("timeout: address null, held flag", [p?.address, p?.addressHeld], [null, true]);
  check("timeout: preceding chatter attached oldest->newest", p?.contextTranscripts, [
    "how is the weather out there",
    "units are clear of the scene",
  ]);
  check("timeout counted", h.core.stats.holdTimeouts, 1);
  check("context counted", h.core.stats.contextAttached, 1);
}

// --- context caps: newest 8, oldest->newest -------------------------------------------
{
  const h = harness();
  for (let i = 1; i <= 12; i++) h.say(`unit ${i} is clear`, 2000);
  h.say("signal 4 on", 20_000).advance(5000 + 41_000);
  const p = h.out[0];
  check("context capped at 8 entries", p?.contextTranscripts?.length, 8);
  check("context keeps the newest 8 in order", [p?.contextTranscripts?.[0], p?.contextTranscripts?.[7]], ["unit 5 is clear", "unit 12 is clear"]);
}

// --- context filters: own keyword, TV/production, already used ----------------------------
{
  const h = harness();
  h.say("4500 West Kennedy Boulevard", 1000);
  h.say("thank you for watching", 2000); // TV barrier
  h.say("tow truck is on scene at 100 Main Street", 2000).advance(5100); // call A: own keyword + address
  check("call A (with address) dispatched", h.out.length, 1);
  h.say("signal 4 on", 3000).advance(5000 + 41_000);
  const b = h.out[1];
  check("call B dispatched as-is", [h.out.length, b?.address], [2, null]);
  check("barrier + keyword chunks + pre-barrier entries are not context", b?.contextTranscripts, undefined);
}
{
  const h = harness();
  h.say("this is a production of 123 Main Street", 1000);
  h.say("the quiet part", 2000);
  h.say("signal 4 on", 12_000).advance(46_000);
  check("production audio never reaches payload or context", [h.out[0]?.transcript, h.out[0]?.contextTranscripts], ["signal 4 on", ["the quiet part"]]);
}
{
  // Context used by an earlier call is not reused by the next one.
  const h = harness();
  h.say("mystery address chatter", 1000);
  h.say("signal 4 on", 12_000).advance(46_000);
  check("first call used the chatter as context", h.out[0]?.contextTranscripts, ["mystery address chatter"]);
  h.say("signal 3 on", 3000).advance(46_000);
  check("second call does not reuse it", h.out[1]?.contextTranscripts, undefined);
}

// --- 90 s window edge -------------------------------------------------------------------
{
  const h = harness();
  h.say("4500 West Kennedy Boulevard", 0);
  h.say("signal 4 on", 90_000).advance(46_000);
  check("context entry exactly 90 s before the call is usable", h.out[0]?.contextTranscripts, ["4500 West Kennedy Boulevard"]);
  const h2 = harness();
  h2.say("4500 West Kennedy Boulevard", 0);
  h2.say("signal 4 on", 91_000).advance(46_000);
  check("context entry 91 s before the call is not", h2.out[0]?.contextTranscripts, undefined);
}

// --- stale address-only chunk must not ride into the next keyword call ------------------------
{
  const h = harness();
  h.say("4500 West Kennedy Boulevard", 0);
  h.say("signal 4 at 100 Main Street", 80_000).advance(5100);
  check("stale address-only chunk is not joined into the transcript", h.out[0]?.transcript, "signal 4 at 100 Main Street");
}
{
  // Lead-in within the same transmission still joins (old behavior preserved).
  const h = harness();
  h.say("4500 West Kennedy Boulevard", 0);
  h.say("signal 4", 4000).advance(5100);
  check("recent lead-in chunk joins the call", [h.out[0]?.transcript, h.out[0]?.address], ["4500 West Kennedy Boulevard signal 4", "4500 West Kennedy Blvd"]);
}
{
  // Keyword clipped across two chunks still arms (joined-buffer rule of the old code).
  const h = harness();
  h.say("signal", 0);
  h.say("4 at 4500 West Kennedy Boulevard", 4000).advance(5100);
  check("keyword split across chunks arms", [h.out.length, h.out[0]?.transcript], [1, "signal 4 at 4500 West Kennedy Boulevard"]);
}
{
  // Old maxChunks=6 cap while armed.
  const h = harness();
  for (let i = 1; i <= 7; i++) h.say(`more words ${i}`, 1000);
  h.say("signal 4 at 4500 West Kennedy Boulevard", 1000);
  for (let i = 8; i <= 11; i++) h.say(`more words ${i}`, 1000);
  h.advance(5100);
  // 12 chunks seen, 5 lead-in + address + 4 more while armed: only the newest 6 are kept (the old maxChunks rule).
  check("armed buffer keeps at most 6 chunks (5 filler + the address chunk)", [(h.out[0]?.transcript.match(/more words/g) || []).length, h.out[0]?.address], [5, "4500 West Kennedy Blvd"]);
}

// --- two calls in one hold ----------------------------------------------------------------
{
  const h = harness();
  h.say("signal 4 on").advance(5000);
  h.say("signal 16 at 1500 North Dale Mabry Highway", 4000);
  check("second (different-class) call splits the hold", h.out.length, 1);
  check("held call goes as-is, address not borrowed from the second call", [h.out[0]?.transcript, h.out[0]?.address], ["signal 4 on", null]);
  h.advance(5100);
  check("second call dispatched with its own address", [h.out.length, h.out[1]?.address], [2, "1500 North Dale Mabry Highway"]);
  check("distinct request ids", h.out[0]?.clientRequestId !== h.out[1]?.clientRequestId, true);
  check("split counted", h.core.stats.holdSplits, 1);
}
{
  // Same incident class completes the held call (tow follows a crash).
  const h = harness();
  h.say("signal 4 on").advance(5000);
  h.say("tow requested at 15th and Bush", 4000).advance(3100);
  check("same-class continuation merges into one call", [h.out.length, h.out[0]?.transcript], [1, "signal 4 on tow requested at 15th and Bush"]);
}

// --- TV/production barrier during a hold --------------------------------------------------------
{
  const h = harness();
  h.say("signal 4 on").advance(5000);
  h.say("this is a production of 123 Main Street", 4000);
  check("barrier ends the hold and sends the call as-is", [h.out.length, h.out[0]?.address, h.out[0]?.transcript], [1, null, "signal 4 on"]);
  check("barrier text is nowhere in the payload", JSON.stringify(h.out[0]).includes("production"), false);
  check("idle after barrier", h.core.getPhase(), "idle");
}
{
  // A real call that happens to contain a TV phrase keeps working (server lets it through too).
  const h = harness();
  h.say("hello hello hello signal 4 at 4500 West Kennedy Boulevard").advance(5100);
  check("soft TV phrase + real call in one chunk is not a barrier", [h.out.length, h.out[0]?.address], [1, "4500 West Kennedy Blvd"]);
}

// --- flush / unmount during hold ---------------------------------------------------------------
{
  const h = harness();
  h.say("signal 4 on").advance(5000);
  const p = h.flush();
  check("flush during hold dispatches immediately", [p.length, p[0]?.address, p[0]?.addressHeld], [1, null, true]);
  check("flush leaves the core idle with no deadline", [h.core.getPhase(), h.core.nextDeadline()], ["idle", null]);
  check("second flush is a no-op", h.flush().length, 0);
}
{
  const h = harness();
  h.say("signal 4 on");
  const p = h.flush();
  check("flush while armed (before the silence timer) dispatches", [p.length, h.core.getPhase()], [1, "idle"]);
}

// --- double-dispatch guard -----------------------------------------------------------------------
{
  const h = harness();
  h.say("signal 4 at 4500 West Kennedy Boulevard");
  const d = h.core.nextDeadline()!;
  const a = h.core.tick(d);
  const b = h.core.flush(d);
  const c = h.core.tick(d + 1);
  check("timer + flush at the same instant: exactly one dispatch", [a.length, b.length, c.length], [1, 0, 0]);
}
{
  const h = harness();
  h.say("signal 4 on").advance(5000 + 41_000);
  h.advance(60_000);
  check("a timed-out hold is dispatched exactly once", h.out.length, 1);
}

// --- hold extension + chunk cap ------------------------------------------------------------------
{
  const h = harness();
  h.say("signal 4 at").advance(5000);
  h.say("1234 McKi", 30_000); // address visibly mid-sentence late in the hold -> one bounded extension
  h.advance(14_000);
  check("late partial address extends the hold (no dispatch at the old 40 s mark)", h.out.length, 0);
  h.advance(25_000);
  check("hold still ends (extension is bounded)", h.out.length, 1);
}
{
  const h = harness();
  h.say("signal 4 on").advance(5000);
  for (let i = 0; i < 10; i++) h.say(`radio chatter number ${i}`, 1000);
  check("10-chunk cap ends the hold", [h.out.length, h.out[0]?.address], [1, null]);
}

// --- hold can be switched off ------------------------------------------------------------------------
{
  const h = harness({ holdEnabled: false });
  h.say("lead in chatter", 0);
  h.say("signal 4 on", 3000).advance(5100);
  check("holdEnabled=false: addressless call is sent at the old time, with context", [h.out.length, h.out[0]?.addressHeld], [1, false]);
}

// --- pure helpers ------------------------------------------------------------------------------------
{
  const prev = { address: "4500 West Kennedy Blvd", signalType: "Signal 4", at: 1000 };
  check("repeat: same address + class within window", isTrueRepeat(prev, { address: "4500 west kennedy blvd.", signalType: "MVA" }, 5000, 15_000), true);
  check("not a repeat: different address", isTrueRepeat(prev, { address: "100 Main Street", signalType: "Signal 4" }, 5000, 15_000), false);
  check("not a repeat: different incident class", isTrueRepeat(prev, { address: "4500 West Kennedy Blvd", signalType: "Signal 16" }, 5000, 15_000), false);
  check("not a repeat: outside window", isTrueRepeat(prev, { address: "4500 West Kennedy Blvd", signalType: "Signal 4" }, 20_000, 15_000), false);
  check("not a repeat: no address on the new call", isTrueRepeat(prev, { address: null, signalType: "Signal 4" }, 5000, 15_000), false);
  check("not a repeat: nothing before", isTrueRepeat(null, { address: "x street", signalType: "Signal 4" }, 5000, 15_000), false);
  check("incident class: crash group", [incidentClass("Tow"), incidentClass("Signal 4"), incidentClass("Signal 16")], ["crash", "crash", "signal16"]);
  check("endsIncomplete", [endsIncomplete("signal 4 at"), endsIncomplete("signal 4 at 1234 McKi"), endsIncomplete("signal 4 at 4500 West Kennedy Boulevard")], [true, true, false]);
  check("looksAddressy", [looksAddressy("1234 McKi"), looksAddressy("ten four"), looksAddressy("on Dale Mabry")], [true, false, true]);
}

console.log(fail === 0 ? "ALL PASS" : `${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
