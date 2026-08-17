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

// Attempt to extract an address from radio transcript
export function extractAddress(transcript: string): string | null {
  const lower = transcript.toLowerCase();

  // Pattern: number + street name + street type
  const streetPattern = /\b(\d{1,6})\s+([a-zA-Z0-9\s]+?)\s+(street|st|avenue|ave|boulevard|blvd|road|rd|drive|dr|lane|ln|way|court|ct|place|pl|highway|hwy|parkway|pkwy|trail|trl|circle|cir)\b/i;
  const match = transcript.match(streetPattern);
  if (match) {
    return match[0].trim();
  }

  // Pattern: highway/interstate references
  const hwyPattern = /\b(?:i-?\d{1,3}|us\s?\d{1,3}|state\s?route\s?\d{1,3}|sr-?\d{1,3}|highway\s?\d{1,3}|hwy\s?\d{1,3})\b/i;
  const hwyMatch = transcript.match(hwyPattern);
  if (hwyMatch) {
    // Try to find intersection info
    const intersectionPattern = new RegExp(hwyMatch[0] + "\\s+(?:and|at|near|&|/)\\s+([a-zA-Z0-9\\s]+?)(?:\\.|,|$)", "i");
    const intMatch = transcript.match(intersectionPattern);
    if (intMatch) {
      return `${hwyMatch[0]} and ${intMatch[1].trim()}`;
    }
    return hwyMatch[0];
  }

  // Pattern: "at" + street name
  const atPattern = /\bat\s+([a-zA-Z0-9\s]+?(?:street|st|avenue|ave|boulevard|blvd|road|rd|drive|dr|lane|ln|way|court|ct|place|pl))\b/i;
  const atMatch = transcript.match(atPattern);
  if (atMatch) {
    return atMatch[1].trim();
  }

  return null;
}
