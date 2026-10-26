// Presentation-only classification of a signalType string into a severity
// bucket, used purely for UI emphasis (card/pin color). Not a business-logic
// change: server dedup/geocoding/review-gate rules are untouched.
export type Severity = "crit" | "warn" | "info";

const CRIT_HINTS = ["Signal 4", "Rollover", "Airbags Deployed", "Rotator Needed"];
const INFO_HINTS = ["Signal 16", "Tow", "Flatbed Needed"];

export function signalSeverity(signalType: string | null | undefined): Severity {
  if (!signalType) return "warn";
  if (CRIT_HINTS.some((hint) => signalType.includes(hint))) return "crit";
  if (INFO_HINTS.some((hint) => signalType.includes(hint))) return "info";
  return "warn";
}

export const SEVERITY_BORDER: Record<Severity, string> = {
  crit: "border-l-red-500",
  warn: "border-l-amber-500",
  info: "border-l-blue-500",
};

export const SEVERITY_TEXT: Record<Severity, string> = {
  crit: "text-red-500",
  warn: "text-amber-500",
  info: "text-blue-500",
};

export const SEVERITY_DOT: Record<Severity, string> = {
  crit: "bg-red-500",
  warn: "bg-amber-500",
  info: "bg-blue-500",
};
