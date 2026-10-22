// Address-rejected keyword calls -> needs_review board events (2026-10-21).
// Run: npx tsx trial/test-review-event.ts
import {
  NEEDS_REVIEW_STATUS,
  isAddressRejection,
  hasDispatchKeyword,
  shouldCreateReviewEvent,
  isSameReviewCall,
} from "../shared/review-event";

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}: ${name}${ok ? "" : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`);
}

const sig4 = { keywords: '[{"keyword":"Signal 4","signalType":"Signal 4"}]', signalType: "Signal 4" };

check("status is distinct from active/accepted/resolved", ["active", "accepted", "resolved"].includes(NEEDS_REVIEW_STATUS), false);
check("resolved-address rejection", isAddressRejection("requires a resolved address"), true);
check("geocode rejection", isAddressRejection("unrecognized street (geocode failed)"), true);
check("spam rejection is not address", isAddressRejection("keyword spam detected"), false);
check("tv audio is not address", isAddressRejection("detected TV/video audio"), false);

check("signal keyword", hasDispatchKeyword(sig4), true);
check("keywords json only", hasDispatchKeyword({ keywords: sig4.keywords, signalType: null }), true);
check("road mention alone is not a call", hasDispatchKeyword({ keywords: '[{"keyword":"Dale Mabry","signalType":"Road Mention"}]', signalType: "Road Mention" }), false);
check("no keywords", hasDispatchKeyword({ keywords: "[]", signalType: null }), false);
check("bad json", hasDispatchKeyword({ keywords: "{", signalType: null }), false);

check("address-rejected Signal 4 -> review", shouldCreateReviewEvent("requires a resolved address", sig4), true);
check("geocode-rejected Signal 4 -> review", shouldCreateReviewEvent("unrecognized street (geocode failed)", sig4), true);
check("spam-rejected -> no review", shouldCreateReviewEvent("keyword spam detected", sig4), false);
check("manual -> no review", shouldCreateReviewEvent("requires a resolved address", { ...sig4, isManual: true }), false);
check("road mention -> no review", shouldCreateReviewEvent("requires a resolved address", { keywords: "[]", signalType: "Road Mention" }), false);

// Same transmission from two desks collapses to one review card.
check(
  "two desks, same call",
  isSameReviewCall(
    { transcript: "Signal 3 at Dale Mabry and Cypress Avenue.", signalType: "Signal 3" },
    { transcript: "Signal 3, at day of May 3, at Cypress Avenue.", signalType: "Signal 3" },
  ),
  true,
);
check(
  "different calls",
  isSameReviewCall(
    { transcript: "Signal 4 at Kennedy and Hubert", signalType: "Signal 4" },
    { transcript: "Signal 4 on the interstate northbound near Fowler exit", signalType: "Signal 4" },
  ),
  false,
);
check("different signal types", isSameReviewCall({ transcript: "a b c", signalType: "Signal 4" }, { transcript: "a b c", signalType: "Signal 16" }), false);

console.log(failures ? `${failures} FAILURES` : "all review-event tests passed");
process.exit(failures ? 1 : 0);
