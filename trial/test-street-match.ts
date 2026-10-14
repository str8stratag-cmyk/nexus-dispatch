import {
  normalizeStreet,
  extractAddressSegments,
  suggestForStem,
  suggestStreets,
  levenshtein,
  type StreetDictionary,
} from "../shared/street-match";

// Fixture dictionary — exercises the matcher mechanics without depending on
// the generated shared/tampa-street-dictionary.json.
const FIXTURE: StreetDictionary = {
  generatedAt: "fixture",
  source: "fixture",
  names: [],
  stems: {
    habana: "Habana Ave",
    "west shore": "West Shore Blvd",
    "50th": "50th St",
    "56th": "56th St",
    azeele: "Azeele St",
    tampania: "Tampania Ave",
    "bruce b downs": "Bruce B Downs Blvd",
    delmar: "Delmar Dr",
    fowler: "Fowler Ave",
    hillsborough: "Hillsborough Ave",
    main: "Main St",
    mane: "Maine Ave",
    park: "Park St",
    bark: "Bark St",
  },
};

let fail = 0;
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) {
    console.log("ok  :", name);
  } else {
    fail++;
    console.log("FAIL:", name);
    console.log("   got: ", g);
    console.log("  want: ", w);
  }
}

// --- levenshtein / normalizeStreet -----------------------------------------
check("levenshtein kitten/sitting", levenshtein("kitten", "sitting"), 3);
check("normalize suffix", normalizeStreet("Habana Ave"), "habana");
check("normalize single-char directional", normalizeStreet("N. Habana Avenue"), "habana");
check("normalize multi-word", normalizeStreet("WEST SHORE BLVD"), "west shore");
check("normalize numbered", normalizeStreet("15th Street"), "15th");
check("normalize keeps multi-char directional", normalizeStreet("East Main St"), "east main");
check("normalize ordinal word", normalizeStreet("Fifteenth St"), "15th");

// --- extractAddressSegments -------------------------------------------------
check(
  "segments strip block+dir+suffix",
  extractAddressSegments("1406, North Delmarie Highway"),
  [{ block: "1406", dir: "north", stem: "delmarie" }],
);
check(
  "segments split intersection",
  extractAddressSegments("azeele amd tampania").map((s) => s.stem),
  ["azeele", "tampania"],
);

// --- suggestForStem ----------------------------------------------------------
check("stem exact", suggestForStem("habana", FIXTURE)?.name, "Habana Ave");
check("stem fuzzy", suggestForStem("habanna", FIXTURE)?.name, "Habana Ave");
check("stem clear winner accepted (marn->main)", suggestForStem("marn", FIXTURE)?.name, "Main St");
// True tie (both candidates distance 1): margin guard must reject. Inline
// dictionary keeps the nonsense stems from polluting the shared fixture.
const TIE_DICT: StreetDictionary = {
  generatedAt: "t",
  source: "t",
  names: [],
  // "tavx" is exactly edit-distance 1 from BOTH stems -> tie, must reject.
  stems: { tavv: "Tavv St", tava: "Tava St" },
};
check("stem tie rejected (tavx~tavv/tava)", suggestForStem("tavx", TIE_DICT), null);
check("stem numbered exact", suggestForStem("50th", FIXTURE)?.name, "50th St");
check("stem numbered guard (59th vs 56th)", suggestForStem("59th", FIXTURE), null);
check("stem no match", suggestForStem("zzqx", FIXTURE), null);

// --- suggestStreets ----------------------------------------------------------
check(
  "address correction preserves block/dir",
  suggestStreets("1406, North Delmarie Highway", FIXTURE).map((s) => [s.correctedAddress, s.score]),
  [["1406 north Delmar Dr", 0.9]],
);
check(
  "intersection both exact",
  suggestStreets("azeele amd tampania", FIXTURE).map((s) => s.correctedAddress),
  ["Azeele St & Tampania Ave"],
);
check(
  "numbered intersection both exact",
  suggestStreets("50th and 56th", FIXTURE).map((s) => s.correctedAddress),
  ["50th St & 56th St"],
);
check("numbered intersection guard", suggestStreets("50th and 57th", FIXTURE), []);
check("chatter gets no suggestion", suggestStreets("I'm gonna back alley", FIXTURE), []);
check(
  "generic substring does not rubber-stamp chatter",
  suggestStreets("I'm gonna back alley", {
    ...FIXTURE,
    stems: { ...FIXTURE.stems, "back road": "Back Road" },
  }),
  [],
);
check(
  "trailing partial word does not rubber-stamp",
  suggestStreets("bra- Union", {
    ...FIXTURE,
    stems: { ...FIXTURE.stems, union: "Union St" },
  }),
  [],
);
check("verbatim junk address gets no suggestion", suggestStreets("E Street", FIXTURE), []);
check("unrelated transcript gets no suggestion", suggestStreets("ever OD 886, Mount Ferguson", FIXTURE), []);
check("three-way intersection left alone", suggestStreets("fowler and hillsborough and main", FIXTURE), []);
check("null dict", suggestStreets("habana", null), []);
// 2026-10-14: short garbled stems fuzzed to the wrong real road ("Oria Road"
// -> "Loria Loop"); they now need an exact dictionary hit.
check(
  "short stem never fuzzes to a different street",
  suggestStreets("oria road", { ...FIXTURE, stems: { ...FIXTURE.stems, loria: "Loria Loop" } }),
  [],
);

console.log(fail === 0 ? "ALL PASS" : `${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
