export interface KeywordEntry {
  pattern: string;
  label: string;
  signalType: string;
}

// Traffic accident keywords for radio transcription filtering. This is the
// seed list used the first time the app runs — after that, the effective
// list lives in the `keyword_list` MongoDB settings document and
// users can add/remove entries (including homophones) from the Settings
// panel without redeploying.
export const DEFAULT_KEYWORDS: KeywordEntry[] = [
  { pattern: "signal 3", label: "Signal 3", signalType: "Signal 3" },
  { pattern: "signal three", label: "Signal 3", signalType: "Signal 3" },
  { pattern: "signal 4", label: "Signal 4", signalType: "Signal 4" },
  // Speech-to-text frequently mishears "four" as "for" (true homophone) and
  // sometimes spells out the number as a word instead of a digit. Cover both
  // so "signal four" and "signal for" are treated the same as "signal 4".
  { pattern: "signal four", label: "Signal 4", signalType: "Signal 4" },
  { pattern: "signal for", label: "Signal 4", signalType: "Signal 4" },
  { pattern: "signal 16", label: "Signal 16", signalType: "Signal 16" },
  { pattern: "signal sixteen", label: "Signal 16", signalType: "Signal 16" },
  { pattern: "mva", label: "MVA", signalType: "MVA" },
  { pattern: "mvc", label: "MVC", signalType: "MVC" },
  { pattern: "crash", label: "Crash", signalType: "Crash" },
  { pattern: "wreck", label: "Wreck", signalType: "Wreck" },
  { pattern: "accident", label: "Accident", signalType: "Accident" },
  { pattern: "rollover", label: "Rollover", signalType: "Rollover" },
  { pattern: "airbags deployed", label: "Airbags Deployed", signalType: "Airbags Deployed" },
  { pattern: "airbag deployed", label: "Airbag Deployed", signalType: "Airbags Deployed" },
  { pattern: "front end damage", label: "Front End Damage", signalType: "Front End Damage" },
  { pattern: "rear end damage", label: "Rear End Damage", signalType: "Rear End Damage" },
  { pattern: "rotator needed", label: "Rotator Needed", signalType: "Rotator Needed" },
  { pattern: "tow", label: "Tow", signalType: "Tow" },
  { pattern: "flatbed needed", label: "Flatbed Needed", signalType: "Flatbed Needed" },
  { pattern: "flatbed", label: "Flatbed", signalType: "Flatbed Needed" },
];

// Detects which keywords (from the given list, defaulting to the built-in
// seed list) appear in a transcript. Only one match per signalType is
// reported even if multiple homophones for it are present.
export function detectKeywords(
  transcript: string,
  keywordList: KeywordEntry[] = DEFAULT_KEYWORDS
): { keyword: string; signalType: string }[] {
  const found: { keyword: string; signalType: string }[] = [];
  const seen = new Set<string>();

  for (const kw of keywordList) {
    if (!kw.pattern) continue;
    const escapedPattern = kw.pattern.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const wholePattern = new RegExp(`(?:^|[^a-z0-9])${escapedPattern}(?=$|[^a-z0-9])`, "i");
    if (wholePattern.test(transcript) && !seen.has(kw.signalType)) {
      seen.add(kw.signalType);
      found.push({ keyword: kw.label, signalType: kw.signalType });
    }
  }

  return found;
}

export function normalizeKeywordEntry(entry: Partial<KeywordEntry>): KeywordEntry | null {
  const pattern = entry.pattern?.trim().toLowerCase();
  if (!pattern) return null;
  const label = entry.label?.trim() || pattern;
  const signalType = entry.signalType?.trim() || label;
  return { pattern, label, signalType };
}
