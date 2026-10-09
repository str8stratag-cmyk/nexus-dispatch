/**
 * Server-side context backfill (shared/address-context.ts) + the shared gate
 * predicates. Pure. Run: npx tsx trial/test-address-context.ts
 */
import { backfillAddressFromContext, isUsableContextEntry, hasDispatchSignalWord } from "../shared/address-context";
import { isInvalidAutoAddress, containsTvVideoPhrase } from "../shared/audio-gates";

let fail = 0;
function check(label: string, got: unknown, want: unknown) {
  const ok = Object.is(got, want) || JSON.stringify(got) === JSON.stringify(want);
  if (!ok) {
    fail++;
    console.log("FAIL:", label, "| got:", JSON.stringify(got), "| want:", JSON.stringify(want));
  } else console.log("ok  :", label);
}

const a = (ctx: string[]) => backfillAddressFromContext(ctx);

check("empty / missing context -> null", [a([]), backfillAddressFromContext(undefined)], [null, null]);
check("no address in context -> null", a(["copy that", "ten four unit twelve"]), null);
check("single address chunk recovered", a(["units clear", "4500 West Kennedy Boulevard"])?.address, "4500 West Kennedy Blvd");
check("cross street kept", a(["Dale Mabry and Gandy"])?.crossStreet != null || a(["Dale Mabry and Gandy"])?.address != null, true);

// chunk-boundary split
check("split across two context entries is recovered from the joined pair", a(["responding to 1234 McKi", "nley Drive"])?.address, "1234 McKi nley Drive");

// two different addresses -> ambiguous, fail closed
check("two different addresses -> null", a(["4500 West Kennedy Boulevard", "100 Main Street"]), null);
check("same address repeated -> still recovered", a(["4500 West Kennedy Boulevard", "again 4500 West Kennedy Boulevard"])?.address, "4500 West Kennedy Blvd");

// barriers
check("production-audio entry is unusable", isUsableContextEntry("this is a production of 123 Main Street"), false);
check("production-audio entry yields no address", a(["this is a production of 123 Main Street"]), null);
check("TV phrase entry yields no address", a(["hello hello hello 123 Main Street"]), null);
check("signal-counting run is unusable", a(["signal 1 signal 2 signal 3 signal 4 signal 5 4500 West Kennedy Boulevard"]), null);
check("entry carrying another call's keyword is unusable", a(["tow truck at 100 Main Street"]), null);
check("'tow' inside another word is not a signal word", [hasDispatchSignalWord("heading toward 4500 West Kennedy"), hasDispatchSignalWord("town of 5")], [false, false]);
check("a usable address next to a barrier entry still resolves from the clean entry", a(["this is a production of 123 Main Street", "4500 West Kennedy Boulevard"])?.address, "4500 West Kennedy Blvd");
check("chatter-like address rejected by the shared predicate", isInvalidAutoAddress("sorry about that"), true);

// caps
const many = Array.from({ length: 12 }, (_, i) => (i === 0 ? "100 Main Street" : `chatter ${i}`));
check("only the newest 8 entries are considered (old address dropped)", a(many), null);
check("oversized entries are truncated, not trusted", a(["x".repeat(2000) + " 4500 West Kennedy Boulevard"]), null);

check("containsTvVideoPhrase unchanged after the move", containsTvVideoPhrase("thanks for watching"), true);

console.log(fail === 0 ? "ALL PASS" : `${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
