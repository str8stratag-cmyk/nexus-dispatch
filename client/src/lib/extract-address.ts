// v3: token-based address extraction with cross-street support for clipped radio calls.
// Returns the primary numbered address (or the first named street for pure intersections)
// plus an optional cross-street when one is mentioned.

const STREET_SUFFIXES = new Set([
  "street", "st", "avenue", "ave", "road", "rd", "boulevard", "blvd", "drive", "dr",
  "lane", "ln", "court", "ct", "circle", "cir", "highway", "hwy", "parkway", "pkwy",
  "place", "pl", "terrace", "ter", "trail", "trl", "way", "loop", "cove", "point",
  "run", "ridge", "rdg", "spur", "plaza", "sq", "square", "alley", "bridge", "bypass",
  "causeway", "center", "centre", "commons", "curve", "divide", "estate", "expressway",
  "freeway", "garden", "gardens", "gate", "green", "grove", "heights", "hill", "hills",
  "hollow", "island", "isle", "junction", "knoll", "lake", "landings", "mall", "manor",
  "meadow", "meadows", "mill", "mills", "mission", "mont", "mount", "mountain", "neck",
  "oval", "overlook", "park", "pass", "path", "pike", "pine", "pines", "prairie", "ranch",
  "river", "route", "row", "shoal", "shore", "spring", "springs", "station", "stravenue",
  "stream", "summit", "throughway", "trace", "track", "trafficway", "trailer", "tunnel",
  "turnpike", "union", "valley", "vista", "village", "vllg", "ville", "walk", "wall",
  "waters", "wells",
]);

const DIRECTIONALS = new Set([
  "n", "s", "e", "w", "ne", "nw", "se", "sw",
  "north", "south", "east", "west",
]);

// Words that should not appear inside a street name and stop backtracking.
const STOP_WORDS = new Set([
  "at", "and", "near", "by", "of", "on", "to", "the", "a", "an", "in", "with",
  "from", "for", "is", "are", "was", "were", "be", "been", "being", "have", "has",
  "had", "do", "does", "did", "will", "would", "could", "should", "may", "might",
  "must", "can", "shall", "we", "you", "they", "he", "she", "it", "i", "me", "my",
  "your", "their", "our", "his", "her", "its", "this", "that", "these", "those",
  "there", "here", "where", "when", "what", "who", "why", "how", "all", "any",
  "some", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "ten", "signal", "sig", "district", "dis", "zone", "channel", "ch", "dispatch",
  "respond", "responding", "enroute", "en route", "unit", "units", "engine", "truck",
  "squad", "medic", "rescue", "tow", "flatbed", "rotator", "wrecker",
  "between", "intersection", "corner", "exit",
]);

// Conjunctions/prepositions that often precede a cross street.
const CROSS_LINKERS = new Set(["and", "at", "near", "by", "/", "between", "intersection", "corner"]);

// Common Whisper mishearings for Hillsborough County street/neighborhood names.
// These are corrected BEFORE street extraction so "mcdull and mlk" becomes
// "mcdill and mlk" and the address parser can find the real street names.
const ADDRESS_HOMOPHONES: [RegExp, string][] = [
  [/\bmcdull\b/gi, "McDill"],
  [/\bmcdonald\b/gi, "McDill"],
  [/\bhigh park\b/gi, "Hyde Park"],
  [/\bmemorial partway\b/gi, "Memorial Parkway"],
  [/\bmemorial parkway\b/gi, "Memorial Parkway"],
  [/\bmemorial highway\b/gi, "Memorial Highway"],
  [/\bmemorial hwy\b/gi, "Memorial Highway"],
  [/\bline\s*ball\b/gi, "Linebaugh"],
  [/\blimbo\b/gi, "Linebaugh"],
  [/\blinebaugh\b/gi, "Linebaugh"],
  [/\bferris city court\b/gi, "Ferris City Court"],
  [/\bcandy\s+blvd\b/gi, "Gandy Blvd"],
  [/\bgandy\s+blvd\b/gi, "Gandy Blvd"],
  [/\bsan\s+mcgull\b/gi, "San Miguel"],
  [/\bdell\s+mavery\b/gi, "Dale Mabry"],
  [/\bdull\s+mabery\b/gi, "Dale Mabry"],
  [/\bdale\s+mabry\b/gi, "Dale Mabry"],
  [/\bloess\s+avenue\b/gi, "Lois Avenue"],
  [/\blowest\b/gi, "Lois"],
  [/\btimes\s+ave\b/gi, "Himes Ave"],
  [/\bhigh\s+ave\b/gi, "Himes Ave"],
  [/\bhimes\s+ave\b/gi, "Himes Ave"],
  [/\bcyber\s+street\b/gi, "Cypress Street"],
  [/\bcyber\s+ave\b/gi, "Cypress Ave"],
  [/\bcolumbos\s+ave\b/gi, "Columbus Ave"],
  [/\bbowler\s+ave\b/gi, "Fowler Ave"],
  [/\bmlk\s+blvd\b/gi, "Martin Luther King Jr Blvd"],
  [/\bmlk\s+boulevard\b/gi, "Martin Luther King Jr Blvd"],
  [/\bmlk\b/gi, "Martin Luther King Jr Blvd"],
  [/\bplatt\s+st\b/gi, "Platt Street"],
  [/\bplatt\s+street\b/gi, "Platt Street"],
];

interface Token {
  text: string;
  index: number;
  isSuffix: boolean;
}

interface StreetCandidate {
  text: string;
  startIndex: number;
  endIndex: number;
  hasNumber: boolean;
  suffix: string;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function cleanWord(word: string): string {
  return word.replace(/^[.,;:]+|[.,;:]+$/g, "").toLowerCase();
}

function cleanStreet(value: string): string {
  return normalizeWhitespace(value).replace(/[.,;]+$/, "").trim();
}

function isStreetSuffix(word: string): boolean {
  return STREET_SUFFIXES.has(cleanWord(word));
}

function tokenize(text: string): Token[] {
  // Split on whitespace but keep slashes and ampersands as standalone tokens.
  return text
    .split(/\s+/)
    .map((text, index) => ({
      text,
      index,
      isSuffix: isStreetSuffix(text),
    }));
}

function isNumberToken(word: string): boolean {
  return /^\d{1,6}[a-z]?$/i.test(word.replace(/[.,;]+$/, ""));
}

function isStandaloneDispatchNumber(word: string): boolean {
  // Single digits like "Signal 4" or "District 2" should not become part of an address.
  const cleaned = word.replace(/[.,;]+$/, "");
  return /^\d$/.test(cleaned);
}

function buildStreetCandidate(tokens: Token[], suffixIndex: number): StreetCandidate | null {
  const suffixToken = tokens[suffixIndex];
  if (!suffixToken || !suffixToken.isSuffix) return null;

  const parts: string[] = [suffixToken.text];
  let hasNumber = false;
  let i = suffixIndex - 1;

  // Walk backward up to 5 tokens to build the street name.
  while (i >= 0 && parts.length < 6) {
    const token = tokens[i];
    const cleaned = cleanWord(token.text);

    // Stop at obvious break words.
    if (STOP_WORDS.has(cleaned)) break;

    // Stop at punctuation-only tokens.
    if (!/^\w/.test(token.text)) break;

    // If we already have a street number, don't absorb a second standalone digit
    // (likely a Signal/District/Zone number that leaked through).
    if (hasNumber && isStandaloneDispatchNumber(token.text)) break;

    // Allow numbers (street numbers or route numbers), directionals, and name words.
    if (isNumberToken(token.text) || DIRECTIONALS.has(cleaned) || /^[a-z0-9.'\-]+$/i.test(token.text)) {
      parts.unshift(token.text);
      if (isNumberToken(token.text)) hasNumber = true;
      i--;
    } else {
      break;
    }
  }

  const text = cleanStreet(parts.join(" "));
  if (!text) return null;

  return {
    text,
    startIndex: i + 1,
    endIndex: suffixIndex,
    hasNumber,
    suffix: cleanWord(suffixToken.text),
  };
}

function findTokenRange(tokens: Token[], text: string): [number, number] | null {
  const words = text.split(/\s+/).map((w) => w.replace(/[.,;]+$/, ""));
  for (let i = 0; i <= tokens.length - words.length; i++) {
    const slice = tokens
      .slice(i, i + words.length)
      .map((t) => t.text.replace(/[.,;]+$/, ""))
      .join(" ");
    if (slice.toLowerCase() === words.join(" ").toLowerCase()) {
      return [i, i + words.length - 1];
    }
  }
  return null;
}

function findRouteCandidates(text: string, tokens: Token[]): StreetCandidate[] {
  const routeRe = /\b(I-\d{1,3}|US\s*\d{1,4}|SR\s*\d{1,4}|State Road\s*\d{1,4}|Route\s*\d{1,4})\b/gi;
  const candidates: StreetCandidate[] = [];
  let match: RegExpExecArray | null;
  while ((match = routeRe.exec(text)) !== null) {
    const range = findTokenRange(tokens, match[1]);
    candidates.push({
      text: cleanStreet(match[1]),
      startIndex: range ? range[0] : -1,
      endIndex: range ? range[1] : -1,
      hasNumber: /\d/.test(match[1]),
      suffix: "hwy",
    });
  }
  return candidates;
}

function findMlkCandidate(text: string, tokens: Token[]): StreetCandidate | null {
  const mlkRe = /\b((?:\d{1,6}[a-z]?\s+(?:[nsew]\s+)?)?Dr\s+Martin\s+Luther\s+King(?:\s+Jr)?\s+(?:Blvd|Boulevard))\b/i;
  const match = text.match(mlkRe);
  if (!match) return null;
  const range = findTokenRange(tokens, match[1]);
  return {
    text: cleanStreet(match[1]),
    startIndex: range ? range[0] : -1,
    endIndex: range ? range[1] : -1,
    hasNumber: /^\d/.test(match[1]),
    suffix: "blvd",
  };
}

function findStreetCandidates(text: string): StreetCandidate[] {
  const tokens = tokenize(text);
  const candidates: StreetCandidate[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].isSuffix) {
      const candidate = buildStreetCandidate(tokens, i);
      if (candidate) candidates.push(candidate);
    }
  }

  // Add special highway/interstate candidates (I-4, US-19, SR-60, etc.).
  candidates.push(...findRouteCandidates(text, tokens));

  // Add special Dr. Martin Luther King Jr. Blvd candidate.
  const mlk = findMlkCandidate(text, tokens);
  if (mlk) candidates.push(mlk);

  return candidates;
}

function streetNameStem(candidate: StreetCandidate): string {
  // Drop the suffix, directionals, and numbers to compare whether two street names are the same.
  const lower = candidate.text.toLowerCase();
  const withoutSuffix = lower.replace(new RegExp(`\\b${candidate.suffix}\\b\\.?`), "").trim();
  return withoutSuffix
    .split(/\s+/)
    .filter((w) => w && !DIRECTIONALS.has(w) && !/^\d+[a-z]?$/i.test(w))
    .join(" ");
}

function normalizeForCompare(text: string): string {
  return text.toLowerCase().replace(/\d+/g, "").replace(/\s+/g, " ").trim();
}

function isSameStreet(a: StreetCandidate, b: StreetCandidate): boolean {
  if (streetNameStem(a) === streetNameStem(b)) return true;

  // One candidate may be a prefix/substring of the other (e.g. "200 E Dr" vs
  // "200 E Dr Martin Luther King Jr Blvd"). Treat them as the same street.
  const na = normalizeForCompare(a.text);
  const nb = normalizeForCompare(b.text);
  if (na.includes(nb) || nb.includes(na)) return true;

  return false;
}

function findCrossStreet(
  text: string,
  primary: StreetCandidate | null,
  candidates: StreetCandidate[]
): StreetCandidate | null {
  const tokens = tokenize(text);
  const primaryEnd = primary ? primary.endIndex : -1;

  // Look for linker tokens (and, at, near, /) near candidate streets.
  for (let i = 0; i < tokens.length; i++) {
    const cleaned = cleanWord(tokens[i].text);
    if (!CROSS_LINKERS.has(cleaned)) continue;

    // Find the nearest street candidate before and after the linker.
    const before = candidates
      .filter((c) => c.endIndex < i && (!primary || !isSameStreet(c, primary)))
      .pop();
    const after = candidates
      .filter((c) => c.startIndex > i && (!primary || !isSameStreet(c, primary)))
      .shift();

    if (after) return after;
    if (before && primaryEnd >= 0 && before.endIndex > primaryEnd) return before;
  }

  // Fallback: pick the first candidate after the primary that is different.
  if (primary) {
    const afterPrimary = candidates.find(
      (c) => c.startIndex > primary.endIndex && !isSameStreet(c, primary)
    );
    if (afterPrimary) return afterPrimary;
  }

  return null;
}

export interface ExtractedAddress {
  address: string | null;
  crossStreet: string | null;
}

// Known Tampa corridors heard WITHOUT their suffix in clipped radio audio
// ("signal 4 Hillsborough and Florida", "MVA on Dale Mabry"). Suffix-based
// extraction finds nothing for these; the geocoder still resolves them with the
// city suffix. Order: multi-word / longest first so specific names win.
const KNOWN_STREET_FALLBACK: [RegExp, string][] = [
  [/\bbruce\s+b\s+downs\b/i, "Bruce B Downs Blvd"],
  [/\b(university\s+)?center\b/i, "University Center"],
  [/\bboy\s+scout\b/i, "Boy Scout Blvd"],
  [/\bhigh\s+park\b/i, "Hyde Park"],
  [/\bhyde\s+park\b/i, "Hyde Park"],
  [/\bdale\s+mabry\b/i, "Dale Mabry"],
  [/\bwest\s*shore\b/i, "Westshore Blvd"],
  [/\bhillsborough\b|\bhillsboro\b/i, "Hillsborough Ave"],
  [/\bfloribraska\b/i, "Floribraska Ave"],
  [/\bflorida\b/i, "N Florida Ave"],
  [/\bnebraska\b/i, "Nebraska Ave"],
  [/\bkennedy\b/i, "Kennedy Blvd"],
  [/\bfowler\b/i, "Fowler Ave"],
  [/\bcolumbus\b/i, "Columbus Dr"],
  [/\bhoward\b/i, "N Howard Ave"],
  [/\bsligh\b/i, "Sligh Ave"],
  [/\bbusch\b/i, "Busch Blvd"],
  [/\bgandy\b/i, "Gandy Blvd"],
  [/\badamo\b/i, "Adamo Dr"],
  [/\bmemorial\b/i, "Memorial Hwy"],
  [/\blois\b/i, "Lois Ave"],
  [/\bhimes\b|\bhines\b/i, "Himes Ave"],
  [/\bselmon\b/i, "Selmon Expy"],
  [/\bcurtis\b/i, "Curtis St"],
  [/\bmlk\b|\bmartin\s+luther\s+king\b/i, "MLK Blvd"],
  [/\bi\s*-\s*275\b/i, "I-275"],
  [/\bi\s*-\s*75\b/i, "I-75"],
  [/\bi\s*-\s*4\b/i, "I-4"],
];

function matchKnownStreets(text: string): string[] {
  const found: string[] = [];
  for (const [pattern, canonical] of KNOWN_STREET_FALLBACK) {
    if (pattern.test(text) && !found.includes(canonical)) {
      found.push(canonical);
    }
  }
  return found;
}

function applyAddressHomophones(text: string): string {
  let corrected = text;
  for (const [pattern, replacement] of ADDRESS_HOMOPHONES) {
    corrected = corrected.replace(pattern, replacement);
  }
  return corrected;
}

export function extractAddress(transcript: string): ExtractedAddress {
  if (!transcript) return { address: null, crossStreet: null };

  const text = normalizeWhitespace(applyAddressHomophones(transcript));
  const candidates = findStreetCandidates(text);
  if (candidates.length === 0) {
    // Suffix-less known streets ("Hillsborough and Florida", "on Dale Mabry"):
    // first match becomes the address, the second the cross street.
    const known = matchKnownStreets(text);
    if (known.length > 0) {
      return { address: known[0], crossStreet: known[1] ?? null };
    }
    return { address: null, crossStreet: null };
  }

  // Prefer numbered addresses. If multiple numbered candidates exist, prefer the
  // longest/most specific one (handles "200 E Dr" vs "200 E Dr Martin Luther King Jr Blvd").
  const numbered = candidates.filter((c) => c.hasNumber);
  const primary = numbered.length > 0
    ? numbered.sort((a, b) => b.text.length - a.text.length)[0]
    : candidates[0];
  const cross = findCrossStreet(text, primary, candidates);

  return {
    address: primary.text,
    crossStreet: cross ? cross.text : null,
  };
}
