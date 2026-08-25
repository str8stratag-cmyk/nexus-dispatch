// v2: safer address extraction with cross-street support for clipped radio calls.
// Returns both the primary numbered address and an optional cross-street.

const STREET_SUFFIX =
  "(?:street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|lane|ln|court|ct|circle|cir|highway|hwy|parkway|pkwy|place|pl|terrace|ter|trail|trl|way|loop|cove|point|run)";

const DIRECT_ADDRESS_REGEX = new RegExp(
  `\\b\\d{1,6}[a-z]?\\s+[A-Za-z0-9.'\\- ]{2,60}?\\b${STREET_SUFFIX}\\b\\.?`,
  "i"
);

const CROSS_ADDRESS_REGEX = new RegExp(
  `\\b(?:cross(?:ing)?\\s+(?:street|st\\.?)?|intersection(?:\\s+of)?|corner\\s+of|near|at|and)\\s+([A-Za-z0-9.'\\- ]{2,60}?\\b${STREET_SUFFIX}\\b\\.?)`,
  "i"
);

function clean(value: string): string {
  return value.replace(/\s+/g, " ").replace(/[.,;]+$/, "").trim();
}

export interface ExtractedAddress {
  address: string | null;
  crossStreet: string | null;
}

export function extractAddress(transcript: string): ExtractedAddress {
  if (!transcript) return { address: null, crossStreet: null };

  const text = transcript.replace(/\s+/g, " ");
  const direct = text.match(DIRECT_ADDRESS_REGEX)?.[0];
  const cross = text.match(CROSS_ADDRESS_REGEX)?.[1];

  return {
    address: direct ? clean(direct) : null,
    crossStreet: cross ? clean(cross) : null,
  };
}
