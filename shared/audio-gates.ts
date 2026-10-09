// Audio-gate predicates shared by the server intake gates (server/routes.ts)
// and the capture client (client/src/lib/dispatch-buffer-core.ts), so both sides
// agree on what counts as TV/production audio, radio-check counting runs, and
// unusable addresses. Moved verbatim from server/routes.ts (2026-10-09); no
// behavior change.

// Phrases that almost always mean the audio captured a TV/video instead of dispatch.
export const TV_VIDEO_PHRASES = [
  "thank you for watching",
  "thanks for watching",
  "that's the end of the video",
  "that is the end of the video",
  "end of the video",
  "like and subscribe",
  "hello hello hello",
  "we interrupt coursework",
  "today's video",
  "this is just a test",
  "thank you and goodbye",
  "subscribe to our channel",
  "visit www.",
  "for more information",
  "check mark",
  "what were you waiting",
  "your daughter",
  "no answer",
  "please return to your seat",
  "what's your name",
  "what would you say",
  "i'll be there for you",
  "why come they need me",
  "live stream",
  "livestream",
  "youtube",
];

// Show/announcement phrases that reject a dispatch UNCONDITIONALLY — a real
// dispatch never follows "this is a production of...", so unlike the soft
// TV_VIDEO_PHRASES these are not bypassed by signal+address heuristics.
export const HARD_PRODUCTION_PHRASES = [
  "this is a production of",
  "thank you for your attention",
  "thanks for watching",
  "thank you for watching",
  // Not banned: the Whisper initial_prompt itself starts with "Dispatch radio
  // terminology", and Whisper echoes that prompt into noisy audio — banning it
  // here quarantines prompt-echo false positives (seen 2026-09-17).
  "one, two, three",
];

// Radio checks / mic tests where someone runs through the signal numbers
// ("signal 3, signal 5, signal 6, ... signal 38"). A real dispatch carries
// one, maybe two signal types — 4+ distinct numbers is a counting run.
export function isSignalCountingRun(transcript: string): boolean {
  const numbers = new Set<string>();
  const re = /\bsignal\s+(\d+)/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(transcript)) !== null) {
    numbers.add(match[1]);
    if (numbers.size >= 4) return true;
  }
  return false;
}

export const STREET_SUFFIX_ONLY = new Set([
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
  "stream", "summit", "throughway", "trace", "track", "trafficway", "trailer", "tunnel",
  "turnpike", "union", "valley", "vista", "village", "vllg", "ville", "walk", "wall",
  "waters", "wells", "track", "court", "point", "drive", "way",
]);

export function normalizeText(value: string): string {
  return (value || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

export function containsTvVideoPhrase(transcript: string): boolean {
  const t = normalizeText(transcript);
  return TV_VIDEO_PHRASES.some((p) => t.includes(p));
}

// Chatter fragments that leak into parsed addresses from non-dispatch audio.
export const ADDRESS_CHATTER = [
  "sorry",
  "thank you",
  "excuse me",
  "you're welcome",
  "live stream",
  "livestream",
];

export function isInvalidAutoAddress(address: string | null | undefined): boolean {
  const a = (address || "").trim().toLowerCase();
  if (!a || a === "" || a.includes("unknown") || a === "n/a" || a === "null") return true;
  // Reject addresses that are just a street suffix (e.g. "wall", "drive", "point").
  if (STREET_SUFFIX_ONLY.has(a)) return true;
  // Reject addresses that are actually conversation fragments.
  if (ADDRESS_CHATTER.some((p) => a.includes(p))) return true;
  return false;
}

export const DISPATCH_SIGNALS = [
  "signal 4", "signal four",
  "signal 3", "signal three",
  "signal 16",
  "mva",
  "wreck",
  "tow",
  "airbags deployed",
  "rollover",
  "accident",
];
