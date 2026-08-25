// The default keyword/homophone list now lives in shared/keywords.ts so the
// server can seed it into persistent storage. Users can add, remove, or
// edit entries (including homophones) from the Settings panel at runtime —
// see the `keyword_list` setting and /api/keywords routes.
export { DEFAULT_KEYWORDS as ACCIDENT_KEYWORDS, type KeywordEntry } from "@shared/keywords";
import { DEFAULT_KEYWORDS, detectKeywords as sharedDetectKeywords, type KeywordEntry as KeywordEntryType } from "@shared/keywords";

export const SIGNAL_TYPES = [
  "Signal 3",
  "Signal 4",
  "Signal 16",
  "MVA",
  "MVC",
  "Crash",
  "Wreck",
  "Accident",
  "Rollover",
  "Airbags Deployed",
  "Front End Damage",
  "Rear End Damage",
  "Rotator Needed",
  "Tow",
  "Flatbed Needed",
];

export const DEFAULT_DISTRICTS = [
  "District 1",
  "District 2",
  "District 3",
  "District 4",
  "District 5",
  "District 6",
  "District 7",
];

// Check if a transcript contains any accident keywords. Pass the current
// effective list (fetched from /api/keywords via useKeywords()) so custom
// additions/removals apply immediately; falls back to the built-in defaults
// if no list is provided.
export function detectKeywords(
  transcript: string,
  keywordList: KeywordEntryType[] = DEFAULT_KEYWORDS
): { keyword: string; signalType: string }[] {
  return sharedDetectKeywords(transcript, keywordList);
}

// v2: address extraction moved to @/lib/extract-address (returns address + crossStreet)
export { extractAddress, type ExtractedAddress } from "./extract-address";
