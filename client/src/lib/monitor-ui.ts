// Presentation helpers for the Saturday-style monitor board (queue cards, map
// pins, transcript chrome). Pure functions — no capture / intake behavior.

export type Severity = "crit" | "warn" | "info";

/** Shape of /api/events rows the board renders (subset of shared/schema.ts). */
export interface BoardEvent {
  id: number;
  transcript: string;
  keywords?: string;
  address: string | null;
  crossStreet: string | null;
  lat: number | null;
  lng: number | null;
  signalType: string | null;
  description: string | null;
  district: string;
  source?: string;
  status?: string;
  isManual?: boolean;
  geocodedRoad: string | null;
  locationApprox?: boolean;
  acceptedBy?: string | null;
  addressFromContext?: boolean;
  createdAt: string;
}

// Injury / high-energy crashes → crit; ordinary crash language → warn;
// tow / flatbed / road mentions → info. Keys are VALID_SIGNAL_TYPES
// (shared/keywords.ts); anything unknown falls back to info.
const SEVERITY: Record<string, Severity> = {
  "Signal 4": "crit",
  Rollover: "crit",
  "Airbags Deployed": "crit",
  "Airbag Deployed": "crit",
  "Signal 3": "warn",
  "Signal 9": "warn",
  MVA: "warn",
  MVC: "warn",
  Crash: "warn",
  Wreck: "warn",
  Accident: "warn",
  "Front End Damage": "warn",
  "Rear End Damage": "warn",
  "Signal 16": "info",
  Tow: "info",
  Flatbed: "info",
  "Flatbed Needed": "info",
  "Rotator Needed": "info",
  "Road Mention": "info",
};

const LABEL: Record<string, string> = {
  "Signal 4": "Crash w/ injury",
  "Signal 3": "Crash",
  "Signal 9": "Signal 9",
  "Signal 16": "Tow request",
  "Road Mention": "Road mention",
};

export function severityOf(signalType: string | null | undefined): Severity {
  return (signalType && SEVERITY[signalType]) || "info";
}

/** Worst severity across a list of signal types (transcript keyword hits). */
export function worstSeverity(signalTypes: Array<string | null | undefined>): Severity {
  const order: Severity[] = ["crit", "warn", "info"];
  let best = 2;
  for (const s of signalTypes) best = Math.min(best, order.indexOf(severityOf(s)));
  return order[best];
}

export function signalLabel(signalType: string | null | undefined): string {
  if (!signalType) return "Incident";
  return LABEL[signalType] ?? signalType;
}

export function formatAddress(e: Pick<BoardEvent, "address" | "crossStreet">): string {
  if (!e.address) return "Address unknown";
  return e.crossStreet && !e.address.toLowerCase().includes(e.crossStreet.toLowerCase())
    ? `${e.address} & ${e.crossStreet}`
    : e.address;
}

/** Saturday relative time: "now", "7m", "2h 05m". */
export function ago(createdAt: string | number, now = Date.now()): string {
  const t = typeof createdAt === "number" ? createdAt : new Date(createdAt).getTime();
  if (!Number.isFinite(t)) return "—";
  const m = Math.max(0, Math.round((now - t) / 60_000));
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d`;
}

export function clockTime(ts: number | string): string {
  return new Date(ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * HTML-escaped text with keyword matches wrapped in <mark>. Both the text and
 * the keywords are escaped first (keywords come from the user-editable list —
 * see transcript-feed.tsx), so the result is safe for dangerouslySetInnerHTML.
 */
export function highlightKeywords(text: string, keywords: string[]): string {
  const html = escapeHtml(text);
  // One alternation pass (longest first) so a later keyword can never match
  // inside a <mark> tag inserted for an earlier one.
  const uniq = Array.from(new Set(keywords.filter(Boolean)))
    .map((kw) => escapeRegExp(escapeHtml(kw)))
    .sort((a, b) => b.length - a.length);
  if (uniq.length === 0) return html;
  return html.replace(new RegExp(`(${uniq.join("|")})`, "gi"), "<mark>$1</mark>");
}

/** Keyword labels stored on an event (JSON in `keywords`) for highlighting. */
export function eventKeywordLabels(e: Pick<BoardEvent, "keywords" | "signalType">): string[] {
  const out: string[] = [];
  try {
    const parsed = JSON.parse(e.keywords || "[]");
    if (Array.isArray(parsed)) {
      for (const k of parsed) if (k && typeof k.keyword === "string") out.push(k.keyword);
    }
  } catch {
    /* malformed keywords column — ignore */
  }
  return out;
}

export function isOpenStatus(status: string | undefined): boolean {
  return status !== "resolved";
}
