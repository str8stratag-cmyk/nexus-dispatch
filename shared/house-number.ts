// House-number helpers for calls split across Whisper chunks (2026-10-16).
//
// Real miss, 2026-10-16 1:44 PM ET: "signal four at three seven" | "one seven
// Hillsborough Avenue." (DISP-5) and "Signal 4, 37, 7... 17 Hillsborough
// Avenue." (DISP-7) were both 3717 Hillsborough Ave. DISP-7 posted first as
// "17 Hillsborough Ave"; DISP-5's correct address was then deduped onto it
// and thrown away. These pure helpers (unit tested in
// trial/test-house-number.ts) let the extractor stitch spoken digits, let
// the server recognise a truncated house number, and let dedupe upgrade an
// existing event instead of discarding the better address.

const SPOKEN_DIGITS: Record<string, string> = {
  zero: "0", oh: "0", o: "0",
  one: "1", two: "2", three: "3", four: "4", five: "5",
  six: "6", seven: "7", eight: "8", nine: "9",
};
const DIGIT_WORD = "(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)";
// Two or more spoken single digits, separated by spaces / commas / hyphens.
const SPOKEN_RUN_RE = new RegExp(`\\b${DIGIT_WORD}(?:[\\s,\\-]+${DIGIT_WORD})+\\b`, "gi");

/**
 * Turn runs of 2+ spoken single digits into a numeral ("three seven one seven
 * Hillsborough" -> "3717 Hillsborough"). A lone digit word ("signal four") is
 * left alone. Only used as a retry by extractAddress, which still has to find
 * a street next to the number, so a run that is not a house number is harmless.
 */
export function convertSpokenDigitRuns(text: string): string {
  if (!text) return text;
  return text.replace(SPOKEN_RUN_RE, (run) =>
    run
      .toLowerCase()
      .split(/[\s,\-]+/)
      .filter(Boolean)
      .map((w) => SPOKEN_DIGITS[w] ?? "")
      .join(""),
  );
}

export interface SplitAddress {
  /** Leading house number, or null. */
  number: string | null;
  /** Normalized remainder (street), lowercase, single-spaced. */
  street: string;
}

export function normAddr(s: string | null | undefined): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function splitHouseNumber(address: string | null | undefined): SplitAddress {
  const n = normAddr(address);
  const m = n.match(/^(\d{1,6})\s+(.*)$/);
  if (m && /[a-z]/.test(m[2])) return { number: m[1], street: m[2] };
  return { number: null, street: n };
}

/** Same street once directionals ("w", "east", ...) are ignored. */
export function sameStreet(a: string, b: string): boolean {
  const strip = (s: string) =>
    s
      .split(" ")
      .filter((t) => !/^(n|s|e|w|north|south|east|west)$/.test(t))
      .join(" ");
  const sa = strip(a);
  const sb = strip(b);
  return sa.length > 0 && sa === sb;
}

export type HouseNumberRelation =
  | "same" // identical number (or both missing) on the same street
  | "upgrade" // `next` is more complete than `prev` on the same street
  | "downgrade" // `next` is less complete than `prev` on the same street
  | "different" // same street, different full house numbers
  | "other-street";

/**
 * Compare two addresses' house numbers. "upgrade" = `prev` has no number and
 * `next` does, or prev's number is a suffix fragment of next's (17 -> 3717).
 */
export function compareHouseNumbers(
  prev: string | null | undefined,
  next: string | null | undefined,
): HouseNumberRelation {
  const a = splitHouseNumber(prev);
  const b = splitHouseNumber(next);
  if (!sameStreet(a.street, b.street)) return "other-street";
  if (a.number === b.number) return "same";
  if (!a.number) return "upgrade";
  if (!b.number) return "downgrade";
  if (b.number.length > a.number.length && b.number.endsWith(a.number)) return "upgrade";
  if (a.number.length > b.number.length && a.number.endsWith(b.number)) return "downgrade";
  return "different";
}

/**
 * True when the house number in `address` looks like the tail of a number that
 * Whisper chopped up in `transcript`: other bare digit groups sit right before
 * it, separated only by punctuation ("37, 7... 17 Hillsborough").
 */
export function hasFragmentedHouseNumber(transcript: string | null | undefined, address: string | null | undefined): boolean {
  const { number, street } = splitHouseNumber(address);
  if (!number || !transcript) return false;
  const firstStreetWord = street.split(" ").find((t) => !/^(n|s|e|w|north|south|east|west)$/.test(t));
  if (!firstStreetWord) return false;
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `\\b\\d{1,5}(?:[\\s,.;:\\-]+\\d{1,5})*[\\s,.;:\\-]*[,.;:\\-][\\s,.;:\\-]*${esc(number)}\\s+(?:[a-z]+\\s+)?${esc(firstStreetWord)}\\b`,
    "i",
  );
  return re.test(convertSpokenDigitRuns(transcript));
}
