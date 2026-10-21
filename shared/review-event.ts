// Address-rejected keyword calls become board events flagged for review
// (2026-10-21). Disp-1/DISP-5 heard real Signal calls today that were rejected
// with "requires a resolved address" / "unrecognized street (geocode failed)"
// and only went to quarantine, so nothing showed on the board. They now also
// create an event with status NEEDS_REVIEW_STATUS: shown on the board in its
// own section, never sent to Telegram, and excluded from dedup / road-mention
// matching (those only look at active/accepted events).
export const NEEDS_REVIEW_STATUS = "needs_review";

const ADDRESS_REJECTION = /requires a resolved address|unrecognized street/i;

export function isAddressRejection(reason: string): boolean {
  return ADDRESS_REJECTION.test(reason);
}

/** Has at least one dispatch keyword (signal/crash), i.e. it's a real call, not chatter. */
export function hasDispatchKeyword(input: { keywords?: string | null; signalType?: string | null }): boolean {
  if (input.signalType && input.signalType.trim() && input.signalType !== "Road Mention") return true;
  if (!input.keywords) return false;
  try {
    const parsed = JSON.parse(input.keywords);
    return Array.isArray(parsed) && parsed.some((k) => k && typeof k === "object" && (k as { signalType?: unknown }).signalType && (k as { signalType?: unknown }).signalType !== "Road Mention");
  } catch {
    return false;
  }
}

export function shouldCreateReviewEvent(reason: string, input: { keywords?: string | null; signalType?: string | null; isManual?: boolean | null }): boolean {
  return !input.isManual && isAddressRejection(reason) && hasDispatchKeyword(input);
}

/** Same transmission heard by several desks: one review card per window. */
export const REVIEW_DEDUP_WINDOW_MS = 120_000;

export function isSameReviewCall(
  a: { transcript?: string | null; signalType?: string | null },
  b: { transcript?: string | null; signalType?: string | null },
): boolean {
  if ((a.signalType ?? "") !== (b.signalType ?? "")) return false;
  const norm = (t?: string | null) => (t ?? "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  const wa = new Set(norm(a.transcript).split(" ").filter((w) => w.length > 2));
  const wb = new Set(norm(b.transcript).split(" ").filter((w) => w.length > 2));
  if (wa.size === 0 || wb.size === 0) return true; // same signal, no content to tell apart
  let common = 0;
  wa.forEach((w) => {
    if (wb.has(w)) common++;
  });
  return common / Math.min(wa.size, wb.size) >= 0.5;
}
