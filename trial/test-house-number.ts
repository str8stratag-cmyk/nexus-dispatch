/**
 * Split-chunk house numbers + dedupe upgrade (2026-10-16 3717 Hillsborough miss).
 * Run: npx tsx trial/test-house-number.ts
 */
import {
  convertSpokenDigitRuns,
  compareHouseNumbers,
  hasFragmentedHouseNumber,
} from "../shared/house-number";
import { extractAddress } from "../shared/extract-address";
import { backfillAddressFromContext } from "../shared/address-context";
import { DispatchBufferCore, extractJoinedAddress, type CorePayload } from "../client/src/lib/dispatch-buffer-core";
import { detectKeywords, DEFAULT_KEYWORDS } from "../shared/keywords";

let fail = 0;
function check(label: string, got: unknown, want: unknown) {
  const ok = Object.is(got, want) || JSON.stringify(got) === JSON.stringify(want);
  if (!ok) {
    fail++;
    console.log("FAIL:", label, "| got:", JSON.stringify(got), "| want:", JSON.stringify(want));
  } else console.log("ok  :", label);
}

// --- spoken digits ------------------------------------------------------------------
check("spoken run -> numeral", convertSpokenDigitRuns("three seven one seven Hillsborough"), "3717 Hillsborough");
check("lone digit word untouched", convertSpokenDigitRuns("signal four at the scene"), "signal four at the scene");
check("extract: DISP-5 chunks joined", extractAddress("signal four at three seven one seven Hillsborough Avenue.").address, "3717 Hillsborough Ave");
check("extract: numerals unchanged", extractAddress("signal 4 at 4500 West Kennedy Boulevard").address, "4500 West Kennedy Blvd");
check("extract: keyword chunk alone has no address", extractAddress("signal four at three seven").address, null);

// --- chunk-boundary numeral stitch ----------------------------------------------------
check("numerals split at boundary are glued", extractJoinedAddress(["signal 4 at 37", "17 Hillsborough Avenue."]).address, "3717 Hillsborough Ave");
check("unit number + full address is not glued (6+ digits)", /^124500/.test(extractJoinedAddress(["signal 4 unit 12", "4500 West Kennedy Boulevard"]).address ?? ""), false);

// --- house-number relation (dedupe + addressesSimilar core) -------------------------
check("17 -> 3717 same street is an upgrade", compareHouseNumbers("17 Hillsborough Ave", "3717 Hillsborough Ave"), "upgrade");
check("no number -> number is an upgrade", compareHouseNumbers("Hillsborough Ave", "3717 Hillsborough Ave"), "upgrade");
check("3717 -> 17 is a downgrade (never applied)", compareHouseNumbers("3717 Hillsborough Ave", "17 Hillsborough Ave"), "downgrade");
check("different full numbers same street stay different", compareHouseNumbers("3700 Hillsborough Ave", "3717 Hillsborough Ave"), "different");
check("directional ignored for street match", compareHouseNumbers("17 Hillsborough Ave", "3717 W Hillsborough Ave"), "upgrade");
check("different streets", compareHouseNumbers("17 Hillsborough Ave", "3717 Florida Ave"), "other-street");

// --- DISP-7 single transcript -------------------------------------------------------
const d7 = "Signal 4, 37, 7... 17 Hillsborough Avenue.";
check("DISP-7: extractor alone gives the fragment", extractAddress(d7).address, "17 Hillsborough Ave");
check("DISP-7: fragment detected", hasFragmentedHouseNumber(d7, "17 Hillsborough Ave"), true);
check("plain number not flagged", hasFragmentedHouseNumber("signal 4 at 17 Hillsborough Avenue", "17 Hillsborough Ave"), false);
const ctx = backfillAddressFromContext(["Yeah, I got you, Victor. 3717 Hillsborough is going to be a dark."]);
check("DISP-7: context has the longer number -> upgrade", compareHouseNumbers("17 Hillsborough Ave", ctx?.address), "upgrade");

// --- buffer: DISP-5 two 6 s chunks --------------------------------------------------
function run(chunks: string[], gapMs = 6000, firstGapMs = gapMs): CorePayload[] {
  const core = new DispatchBufferCore({ detectKeywords: (t) => detectKeywords(t, DEFAULT_KEYWORDS), newId: () => "r" });
  let t = 1_000_000;
  const out: CorePayload[] = [];
  const advance = (ms: number) => {
    const target = t + ms;
    for (;;) {
      const d = core.nextDeadline();
      if (d === null || d > target) break;
      t = Math.max(t, d);
      out.push(...core.tick(t));
    }
    t = target;
  };
  for (const [i, c] of chunks.entries()) {
    advance(i === 1 ? firstGapMs : gapMs);
    out.push(...core.push(c, t));
  }
  advance(70_000);
  return out;
}
{
  const out = run(["signal four at three seven", "one seven Hillsborough Avenue."]);
  check("DISP-5: one dispatch", out.length, 1);
  check("DISP-5: stitched to 3717", out[0]?.address, "3717 Hillsborough Ave");
}
{
  const out = run(["Yeah, I got you, Victor. 3717 Hillsborough is going to be a dark.", d7], 6000, 20_000);
  check("DISP-7: posted address is the fragment", out[0]?.address, "17 Hillsborough Ave");
  check("DISP-7: one dispatch", out.length, 1);
  check("DISP-7: context attached for the server upgrade", (out[0]?.contextTranscripts ?? []).length > 0, true);
}
{
  const out = run(["signal 4 at 3700 Hillsborough Avenue"]);
  check("no-regression: full address sends without context", [out[0]?.address, out[0]?.contextTranscripts], ["3700 Hillsborough Ave", undefined]);
}

console.log(fail === 0 ? "ALL PASS" : `${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
