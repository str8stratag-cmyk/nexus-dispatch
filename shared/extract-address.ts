// v3: token-based address extraction with cross-street support for clipped radio calls.
// Returns the primary numbered address (or the first named street for pure intersections)
// plus an optional cross-street when one is mentioned.

const STREET_SUFFIXES = new Set([
  "street", "st", "avenue", "ave", "road", "rd", "boulevard", "blvd", "drive", "dr",
  "lane", "ln", "court", "ct", "circle", "cir", "highway", "hwy", "parkway", "pkwy",
  "place", "pl", "terrace", "ter", "trail", "trl", "way", "loop", "cove", "point",
  "run", "ridge", "rdg", "spur", "plaza", "sq", "square", "alley", "bridge", "bypass",
  "causeway", "center", "centre", "commons", "curve", "divide", "estate", "expressway", "expy",
  "freeway", "garden", "gardens", "gate", "green", "grove", "heights", "hill", "hills",
  "hollow", "island", "isle", "junction", "knoll", "lake", "landings", "mall", "manor",
  "meadow", "meadows", "mill", "mills", "mission", "mont", "mount", "mountain", "neck",
  "oval", "overlook", "park", "pass", "path", "pike", "pine", "pines", "prairie", "ranch",
  "river", "route", "row", "shoal", "shore", "spring", "springs", "station", "stravenue",
  "mabry", "linebaugh", "cypress", "henderson", "handler",
  "stream", "summit", "throughway", "trace", "track", "trafficway", "trailer", "tunnel",
  "turnpike", "union", "valley", "vista", "village", "vllg", "ville", "walk", "wall",
  "waters", "wells",
]);

const DIRECTIONALS = new Set([
  "n", "s", "e", "w", "ne", "nw", "se", "sw",
  "north", "south", "east", "west",
]);

// Street names in STREET_SUFFIXES that are also ordinary words/surnames
// (2026-10-01 review). "handler" only counts right after a directional
// ("304 East Handler", never "K9 handler en route"); "henderson" never right
// after a personal title ("officer Henderson on scene").
const DIRECTIONAL_ONLY_SUFFIXES = new Set(["handler"]);
const SURNAME_SUFFIXES = new Set(["henderson"]);
const PERSON_TITLES = new Set([
  "officer", "deputy", "sergeant", "sgt", "corporal", "cpl", "detective", "det",
  "lieutenant", "lt", "captain", "capt", "trooper", "chief", "agent",
  "mr", "mrs", "ms", "miss", "dr",
]);

// Words that should not appear inside a street name and stop backtracking.
// Includes generic suffix abbreviations so consecutive street names don't
// fuse ("Fowler Ave Fletcher Ave") and dispatch jargon that precedes roads.
const STOP_WORDS = new Set([
  // "amd" is Whisper's mis-hearing of "and" between street names (event 862,
  // "AZEELE AMD TAMPANIA") — server/routes.ts's INTERSECTION_SPLIT_RE and
  // whisper_service.py both treat it as "and"; this client-side extractor
  // hadn't, so it fused "amd" into the street name instead of splitting on
  // it (found 2026-09-22).
  "at", "and", "amd", "near", "by", "of", "on", "to", "the", "a", "an", "in", "with",
  "from", "for", "is", "are", "was", "were", "be", "been", "being", "have", "has",
  "had", "do", "does", "did", "will", "would", "could", "should", "may", "might",
  "must", "can", "shall", "we", "you", "they", "he", "she", "it", "i", "me", "my",
  "your", "their", "our", "his", "her", "its", "this", "that", "these", "those",
  "there", "here", "where", "when", "what", "who", "why", "how", "all", "any",
  "some", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "ten", "signal", "sig", "district", "dis", "zone", "channel", "ch", "dispatch",
  "respond", "responding", "enroute", "en route", "unit", "units", "engine", "truck",
  "squad", "medic", "rescue", "tow", "flatbed", "rotator", "wrecker",
  "mva", "mvc", "nba", "nbc", "crash",
  "between", "intersection", "corner", "exit",
  // Generic suffix abbreviations: stop backtracking so back-to-back street
  // names stay separate. Local name-suffixes (mabry, linebaugh, cypress,
  // shore, waters...) are deliberately NOT here — they must stay absorbable.
  "ave", "avenue", "blvd", "boulevard", "st", "street", "rd", "road", "dr",
  "drive", "ln", "lane", "ct", "court", "cir", "circle", "hwy", "highway",
  "pkwy", "parkway", "pl", "place", "ter", "terrace", "trl", "trail", "way",
]);

// Candidate texts that are places, not street addresses.
const CANDIDATE_BLOCKLIST = new Set(["busch gardens", "great way"]);

// Conjunctions/prepositions that often precede a cross street.
const CROSS_LINKERS = new Set(["and", "amd", "at", "in", "near", "by", "/", "between", "intersection", "corner"]);

// Common Whisper mishearings for Hillsborough County street/neighborhood names.
// These are corrected BEFORE street extraction so "mcdull and mlk" becomes
// "mcdill and mlk" and the address parser can find the real street names.
const ADDRESS_HOMOPHONES: [RegExp, string][] = [
  // "304 East Handler" (2026-10-01, real quarantine misses across DISP-1/
  // 2/5/7, user-confirmed canonical name 2026-10-01). "Tambler" is the
  // mishearing to fix; "Handler" itself is already correct when heard right.
  [/\btambler\b/gi, "Handler"],
  // Armenia Ave & Broad St (2026-10-01, real DISP-2/3 quarantine misses,
  // user-confirmed). "Barat" for "Broad"; "Armenian" (the nationality
  // adjective) for "Armenia".
  // Street context only ("Barat Street", "West Barat") - "Barat" is also a
  // surname, so it is never rewritten bare.
  [/\bbarat(?=\s+st(?:reet)?\b)/gi, "Broad"],
  [/(?<=\b(?:north|south|east|west)\s+)barat\b/gi, "Broad"],
  // "Armenian" is a real word (could describe a person, not just the
  // street) - unlike "Barat"/"Tambler", scoped to require "Avenue"/"Ave"
  // (how it actually appeared in both real transcripts) rather than bare.
  [/\barmenian\s+(?:avenue|ave)\b/gi, "Armenia Ave"],
  // Selmon/Crosstown Expressway (2026-09-30, real DISP-5 quarantine miss:
  // "settlement expressway" for "Selmon Expressway"; also "salmon"/
  // "sandman"/"sellman"). Bare match, no "expressway"/"expy" required —
  // real dispatchers say it bare ~98% of the time (user, 2026-09-30), same
  // as "Selmon"/"Crosstown" below. Accepted tradeoff: a literal, unrelated
  // "salmon"/"sandman" mention in dispatch chatter would also get rewritten,
  // judged unlikely enough in this domain to be worth catching the common case.
  [/\b(?:settlement|salmon|sandman|sellman)(?:\s+expressway|\s+expy)?\b/gi, "Selmon Expy"],
  [/\bselmon(?:\s+expressway|\s+expy)?\b/gi, "Selmon Expy"],
  [/\bcrosstown(?:\s+expressway|\s+expy)?\b/gi, "Selmon Expy"],
  [/\bgandhi\s+boulevard\b/gi, "Gandy Blvd"],
  [/\bgandhi\s+blvd\b/gi, "Gandy Blvd"],
  [/\bgandhi\b/gi, "Gandy"],
  [/\bgandy\s+boulevard\b/gi, "Gandy Blvd"],
  [/\bdale\s+mason\b/gi, "Dale Mabry"],
  [/\bmcdull\b/gi, "McDill"],
  [/\bmcdonald\b/gi, "McDill"],
  [/\bhigh park\b/gi, "Hyde Park"],
  [/\bharford\b/gi, "Harvey"],
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
  [/\bdealt\s+maybury\b/gi, "Dale Mabry"],
  [/\bdale\s+maybury\b/gi, "Dale Mabry"],
  [/\bdale\s+mayberry\b/gi, "Dale Mabry"],
  [/\bdealt\s+mabry\b/gi, "Dale Mabry"],
  [/\bdale\s+labrie\b/gi, "Dale Mabry"],
  // "Dale may be" (2026-09-30, live in the DISP-5 quarantine queue). Only in
  // a street position, so a person named Dale ("officer Dale may be late")
  // is left alone.
  [/\bdale\s+may\s+be\b(?=\s*(?:[,.;:!?]|$)|\s+(?:&|(?:and|at|highway|hwy|north|south|east|west|northbound|southbound|thank)\b))/gi, "Dale Mabry"],
  // "Delmarie Highway" / bare "South down Mabry" (2026-10-01, real
  // quarantine misses - extracted a directional phrase instead of just the
  // street, so geocoding failed even though the street itself was right).
  [/\bdelmarie(?:\s+highway|\s+hwy)?\b/gi, "Dale Mabry Hwy"],
  // Drop the directional prefix rather than keep it in the geocoded address
  // - "Dale Mabry" alone is proven to geocode; a directional-prefixed
  // compound is an unverified guess at a format that might fail the same way.
  [/\bsouth\s*down(?:\s+dale)?\s+mabry\b/gi, "Dale Mabry"],
  [/\bsouth\s*down(?:\s+dale)?\s+maybury\b/gi, "Dale Mabry"],
  // "Kenney Boulevard" for "Kennedy Blvd" (2026-10-01, real quarantine miss).
  // Requires the suffix - bare "Kenney" is a surname.
  [/\bkenney\s+(?:blvd|boulevard)\b/gi, "Kennedy Blvd"],
  [/\bmaybury\b/gi, "Mabry"],
  // NOTE: no Anderson -> Henderson rewrite. Both are real Tampa roads
  // (owner decision 2026-10-01).
  [/\bloess\s+avenue\b/gi, "Lois Avenue"],
  [/\blowest\b/gi, "Lois"],
  [/\btimes\s+ave\b/gi, "Himes Ave"],
  [/\bhigh\s+ave\b/gi, "Himes Ave"],
  [/\bhimes\s+ave\b/gi, "Himes Ave"],
  [/\bcyber\s+street\b/gi, "Cypress Street"],
  [/\bcyber\s+ave\b/gi, "Cypress Ave"],
  [/\bcolumbos\s+ave\b/gi, "Columbus Ave"],
  [/\bbowler\s+ave\b/gi, "Fowler Ave"],
  // Bruce B Downs Blvd (2026-09-25 DISP-3 miss: the 09:07 "Signal 4 at Bruce
  // B Downs and Fowler" call was transcribed "crispy downs ... Signal 4 at
  // Bruce Viana" and quarantined with no address). Every alias is anchored on
  // a two-word phrase ("bruce ... downs", "bruce viana", "crispy downs") so a
  // bare "Bruce" or "downs" never becomes an address.
  [/\bbruce\s+(?:b|be|bee|v|vee|d|p)\.?\s+downs?(?:\s+blvd|\s+boulevard)?\b/gi, "Bruce B Downs Blvd"],
  [/\bbruce(?:y|ie)?\s+downs(?:\s+blvd|\s+boulevard)?\b/gi, "Bruce B Downs Blvd"],
  [/\bbruce\s+vi(?:a|e)nn?a\b/gi, "Bruce B Downs Blvd"],
  [/\bcrispy\s+downs\b/gi, "Bruce B Downs Blvd"],
  [/\bmlk\s+blvd\b/gi, "Martin Luther King Jr Blvd"],
  [/\bmlk\s+boulevard\b/gi, "Martin Luther King Jr Blvd"],
  [/\bmlk\b/gi, "Martin Luther King Jr Blvd"],
  [/\bplatt\s+st\b/gi, "Platt Street"],
  [/\bplatt\s+street\b/gi, "Platt Street"],
  // Major Tampa roads are usually spoken with NO suffix ("on Hillsborough",
  // "at Busch and 56th"). Canonicalize bare mentions to their full form so
  // they extract as addresses. Optional-suffix groups keep already-suffixed
  // forms canonical without doubling up.
  [/(?<!\bof\s)\bflorida(?:\s+ave(?:nue)?)?\b(?!\s+state)/gi, "Florida Ave"],
  [/\bfloribraska\b/gi, "Nebraska Ave"],
  [/\bpalesboro\b/gi, "Hillsborough"],
  [/\bhillsbough\b/gi, "Hillsborough"],
  [/\bhi?l+s+borough(?:\s+ave(?:nue)?)?\b(?!\s+county)/gi, "Hillsborough Ave"],
  [/\bfowller\b/gi, "Fowler"],
  // Spelling garbles of Fowler only. Sound-alikes ("sour", "fine") are NOT
  // mapped: they are common words and would invent cross streets.
  [/\bfouler\b/gi, "Fowler"],
  [/\bfowlers\b/gi, "Fowler"],
  [/\bfowler(?:\s+ave(?:nue)?)?\b/gi, "Fowler Ave"],
  [/\bfletcher(?:\s+ave(?:nue)?)?\b/gi, "Fletcher Ave"],
  [/\bwaters(?:\s+ave(?:nue)?)?\b/gi, "Waters Ave"],
  [/\bhimes(?:\s+ave(?:nue)?)?\b/gi, "Himes Ave"],
  [/\bdale\s+marby\b/gi, "Dale Mabry"],
  [/\bcolumbus(?:\s+ave(?:nue)?|\s+dr(?:ive)?)?\b/gi, "Columbus Ave"],
  [/\b50th(?:\s+st(?:reet)?)?\b/gi, "50th St"],
  [/\b56th(?:\s+st(?:reet)?)?\b/gi, "56th St"],
  [/\b30th(?:\s+st(?:reet)?)?\b/gi, "30th St"],
  [/\b40th(?:\s+st(?:reet)?)?\b/gi, "40th St"],
  [/\babbot\s+bush\b/gi, "Busch"],
  // "bushed" (2026-09-30 call review): \bbush\b alone doesn't match — "bush"
  // and "ed" are one contiguous word, no boundary between them.
  [/\bbush(?:ed)?\b/gi, "Busch"],
  [/\be-brush\b/gi, "Busch"],
  [/\bbresh\b/gi, "Busch"],
  // Whisper small hears "Busch" as "bridge" before a block number
  // ("e-brush 3, bridge 29" -> "Busch ... and 29"). Only rewrite when a
  // number follows so real bridge talk ("bridge closure") is untouched.
  [/\bbridge\s+(\d{1,3})\b/gi, "and $1"],
  [/\bbusch(?:\s+blvd|\s+boulevard)?\b(?!\s+gardens)/gi, "Busch Blvd"],
  [/\bsligh(?:\s+ave(?:nue)?)?\b/gi, "Sligh Ave"],
  [/\bkennedy(?:\s+blvd|\s+boulevard)?\b/gi, "Kennedy Blvd"],
  [/\bbroadway(?:\s+ave(?:nue)?)?\b/gi, "Broadway Ave"],
  [/\bbayshore(?:\s+blvd|\s+boulevard)?\b/gi, "Bayshore Blvd"],
  [/\bwest\s+shore(?:\s+blvd|\s+boulevard)?\b/gi, "West Shore Blvd"],
  [/\bgandy(?:\s+blvd|\s+boulevard)?\b/gi, "Gandy Blvd"],
  [/\bmemorial\b(?!\s+parkway)/gi, "Memorial Highway"],
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
  // Street numbers and spoken ordinals ("30th", "50th", "808", "4a").
  return /^\d{1,6}(?:st|nd|rd|th)?[a-z]?$/i.test(word.replace(/[.,;]+$/, ""));
}

function isStandaloneDispatchNumber(word: string): boolean {
  // Single digits like "Signal 4" or "District 2" should not become part of an address.
  const cleaned = word.replace(/[.,;]+$/, "");
  return /^\d$/.test(cleaned);
}

function buildStreetCandidate(tokens: Token[], suffixIndex: number): StreetCandidate | null {
  const suffixToken = tokens[suffixIndex];
  if (!suffixToken || !suffixToken.isSuffix) return null;
  const suffixWord = cleanWord(suffixToken.text);
  const prevWord = suffixIndex > 0 ? cleanWord(tokens[suffixIndex - 1].text) : "";
  if (DIRECTIONAL_ONLY_SUFFIXES.has(suffixWord) && !DIRECTIONALS.has(prevWord)) return null;
  if (SURNAME_SUFFIXES.has(suffixWord) && PERSON_TITLES.has(prevWord)) return null;

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

    // Never absorb across a sentence boundary: a token ending in "." ends
    // the previous utterance ("...electrical. Florida Ave", "...nba. 3rd
    // street"). Real street-name words don't carry periods mid-name.
    if (/\.$/.test(token.text)) break;

    // Never absorb a standalone single digit immediately followed by a
    // comma - it's virtually always a leaked Signal/District/Zone number
    // with its natural pause still intact ("signal 4, Dale Mabry" was
    // misparsed as address "4, Dale Mabry", 2026-09-30 real quarantine
    // miss), never a real house number in this fleet's data. Scoped to the
    // comma (not just "is it a standalone digit") so a signal number fused
    // straight into a longer phrase with no pause ("signal 4 NISSAN MURANO
    // RAN OFF ROAD...") still absorbs normally - same class of token,
    // different punctuation, different real-world meaning. Previously only
    // guarded a SECOND digit (hasNumber &&); a lone leading one with a
    // comma slipped through the same way.
    if (/^\d,$/.test(token.text)) break;
    // Still never absorb a SECOND standalone digit after a street number
    // (pre-existing guard, kept alongside the comma rule above).
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
      if (candidate && !CANDIDATE_BLOCKLIST.has(candidate.text.toLowerCase())) {
        candidates.push(candidate);
      }
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

    // Either side of the linker can be the cross street: "Busch Blvd and
    // 56th" (named-then-numbered) is as valid as "56th and Busch Blvd".
    if (after) return after;
    if (before) return before;
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
  [/\bbruce\s+b\s+downs\b|\bbruce\s+(?:be|bee|v|vee)\s+downs\b|\bbruce(?:y|ie)?\s+downs\b|\bbruce\s+vi(?:a|e)nn?a\b|\bcrispy\s+downs\b/i, "Bruce B Downs Blvd"],
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
  [/\bfowler\b|\bfouler\b|\bfowlers\b/i, "Fowler Ave"],
  [/\bcolumbus\b/i, "Columbus Dr"],
  [/\bhoward\b/i, "N Howard Ave"],
  [/\bsligh\b/i, "Sligh Ave"],
  [/\bbusch\b/i, "Busch Blvd"],
  [/\bgandy\b/i, "Gandy Blvd"],
  [/\badamo\b/i, "Adamo Dr"],
  [/\bmemorial\b/i, "Memorial Hwy"],
  [/\blois\b/i, "Lois Ave"],
  [/\bhimes\b|\bhines\b/i, "Himes Ave"],
  // Henderson (2026-09-30 call review) - must stay after "Dale Mabry" above
  // so matchKnownStreets returns [Dale Mabry, Henderson] in that order for
  // "Dale Mabry and Henderson" (this array's iteration order determines
  // result order, not the transcript's word order).
  [/(?<!\b(?:officer|deputy|sergeant|sgt|corporal|cpl|detective|det|lieutenant|lt|captain|capt|trooper|chief|agent|mr|mrs|ms|miss|dr)\.?\s+)\bhenderson\b/i, "Henderson Blvd"],
  [/\bselmon\b/i, "Selmon Expy"],
  [/\bcrosstown\b/i, "Selmon Expy"],
  // Armenia Ave & Broad St (2026-10-01, real DISP-2/3 quarantine misses,
  // user-confirmed intersection). "Broad" only in a street context ("broad
  // street", "west broad", paired with Armenia) - never bare, so "in broad
  // daylight" does not produce an address.
  [/\barmenia\b/i, "Armenia Ave"],
  [/\bbroad\s+st(?:reet)?\b|\b(?:north|south|east|west)\s+broad\b|\barmenia\s+(?:ave(?:nue)?\s+)?(?:and|&|at)\s+broad\b|\bbroad\s+(?:and|&|at)\s+armenia\b/i, "Broad St"],
  [/\bcurtis\b/i, "Curtis St"],
  [/\bmlk\b|\bmartin\s+luther\s+king\b/i, "MLK Blvd"],
  [/\bi\s*-\s*275\b/i, "I-275"],
  [/\bi\s*-\s*75\b/i, "I-75"],
  [/\bi\s*-\s*4\b/i, "I-4"],
  // Heard bare in clipped audio (2026-09-24 DISP-3 misses). "Lake Nona" and
  // "East of Nona" both hit the bare-word pattern. Kept last so they never
  // outrank an existing corridor for the address/cross-street order.
  [/\b(?:lake\s+)?nona\b/i, "Nona"],
  [/\bhyacinth\b/i, "Hyacinth"],
];

// First word of a canonical street name that identifies it in speech
// ("N Florida Ave" -> "florida", "Bruce B Downs Blvd" -> "bruce"). Numbered
// routes (I-275) return null: a number before them is not a block number.
function streetKeyword(canonical: string): string | null {
  if (/\d/.test(canonical)) return null;
  const words = canonical
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !DIRECTIONALS.has(w));
  return words[0] ?? null;
}

function wordMatchesKeyword(word: string, keyword: string): boolean {
  const w = word.toLowerCase();
  if (w === keyword) return true;
  // Tolerate clipped/extended spellings ("hillsboro" / "hillsborough").
  return w.length >= 4 && (keyword.startsWith(w) || w.startsWith(keyword));
}

// A 3-5 digit block number IMMEDIATELY naming the street: optional
// "block (of)", one optional directional, optional "of", then the street
// word itself ("5011 East Busch", "1910 East of Nona", "2400 block of
// Fowler"). Deliberately strict: "unit 1234 on Busch" or "1430 hours" must
// not become a street address.
const BLOCK_NUMBER_RE = /\b(\d{3,5})\s+(?:block\s+(?:of\s+)?)?(?:(?:north|south|east|west|[nsew]\.?)\s+)?(?:of\s+)?([a-z][a-z']*)/gi;

function attachBlockNumber(text: string, known: string[]): ExtractedAddress | null {
  for (const match of Array.from(text.matchAll(BLOCK_NUMBER_RE))) {
    const hit = known.find((k) => {
      const keyword = streetKeyword(k);
      return keyword !== null && wordMatchesKeyword(match[2], keyword);
    });
    if (hit) {
      return { address: `${match[1]} ${hit}`, crossStreet: known.find((k) => k !== hit) ?? null };
    }
  }
  return null;
}

// Relative block location on a street the lists don't know, heard without a
// suffix: "at 1910 East of Nona" style -> "1910 Nona". One street word only
// (plus an optional suffix) so trailing chatter is never swallowed.
const RELATIVE_BLOCK_RE = /\b(?:at|on|near)\s+(\d{3,5})\s+(?:north|south|east|west)\s+of\s+([a-z][a-z']{2,})(?:\s+(road|rd|street|st|avenue|ave|boulevard|blvd|drive|dr|lane|ln|parkway|pkwy))?\b/i;

function matchRelativeBlock(text: string): string | null {
  const m = text.match(RELATIVE_BLOCK_RE);
  if (!m) return null;
  const name = m[2].toLowerCase();
  if (STOP_WORDS.has(name) || DIRECTIONALS.has(name)) return null;
  const street = m[2].charAt(0).toUpperCase() + m[2].slice(1).toLowerCase();
  return m[3] ? `${m[1]} ${street} ${m[3]}` : `${m[1]} ${street}`;
}

function matchKnownStreets(text: string): string[] {
  const found: string[] = [];
  for (const [pattern, canonical] of KNOWN_STREET_FALLBACK) {
    if (pattern.test(text) && !found.includes(canonical)) {
      found.push(canonical);
    }
  }
  return found;
}

export function applyAddressHomophones(text: string): string {
  let corrected = text;
  for (const [pattern, replacement] of ADDRESS_HOMOPHONES) {
    corrected = corrected.replace(pattern, replacement);
  }
  return corrected;
}

// Major roads that warrant a review dispatch even when no crash keyword was
// detected — dispatchers name them bare ("on Hillsborough", "at Busch and
// 56th") and those calls used to be dropped entirely. Tested AFTER homophone
// correction so mishearings (gandhi -> Gandy) still count.
const MAJOR_ROAD_RE = /\b(Florida Ave|Nebraska Ave|Hillsborough Ave|Fowler Ave|Fletcher Ave|Waters Ave|Himes Ave|Dale Mabry|Columbus Ave|Memorial Highway|50th St|56th St|30th St|Busch Blvd|Sligh Ave|Kennedy Blvd|Martin Luther King Jr Blvd|Cypress|Broadway Ave|Bayshore Blvd|Gandy Blvd|West Shore Blvd|Selmon Expy|Henderson Blvd|Armenia Ave|Broad St)\b/i;

export function containsMajorRoad(transcript: string): boolean {
  if (!transcript) return false;
  return MAJOR_ROAD_RE.test(applyAddressHomophones(transcript));
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
      // Keep a block number that directly names one of the streets.
      const numbered = attachBlockNumber(text, known);
      if (numbered) return numbered;
      return { address: known[0], crossStreet: known[1] ?? null };
    }
    const relative = matchRelativeBlock(text);
    if (relative) return { address: relative, crossStreet: null };
    return { address: null, crossStreet: null };
  }

  // Prefer numbered addresses. If multiple numbered candidates exist, prefer the
  // longest/most specific one (handles "200 E Dr" vs "200 E Dr Martin Luther King Jr Blvd").
  const numbered = candidates.filter((c) => c.hasNumber);
  const primary = numbered.length > 0
    ? numbered.sort((a, b) => b.text.length - a.text.length)[0]
    // No numbers: take the most specific (longest) name — "West Shore Blvd"
    // over the bare "West Shore" that the same tokens also produce.
    : candidates.reduce((a, b) => (b.text.length > a.text.length ? b : a));
  const cross = findCrossStreet(text, primary, candidates);

  return {
    address: primary.text,
    crossStreet: cross ? cross.text : null,
  };
}
