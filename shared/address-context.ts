// Address recovery from surrounding audio (2026-10-09).
//
// A call is often split across radio chunks ("signal 4 on" ... "4500 West
// Kennedy Boulevard"), so the chunk that carries the dispatch keyword has no
// address and the auto-dispatch gate rejects it ("requires a resolved
// address"). The capture client now sends the neighbouring transcripts as
// `contextTranscripts`; this pure function (used by server/routes.ts and unit
// tested in trial/test-address-context.ts) decides whether they can supply the
// address. It fails closed: any doubt -> no address.

import { extractAddress } from "./extract-address";
import {
  HARD_PRODUCTION_PHRASES,
  DISPATCH_SIGNALS,
  containsTvVideoPhrase,
  isInvalidAutoAddress,
  isSignalCountingRun,
  normalizeText,
} from "./audio-gates";

export const CONTEXT_MAX_ENTRIES = 8;
export const CONTEXT_MAX_ENTRY_CHARS = 500;

/** True when the text names a dispatch signal as a whole word ("tow", not "town"). */
export function hasDispatchSignalWord(text: string): boolean {
  const t = normalizeText(text);
  return DISPATCH_SIGNALS.some((s) => new RegExp(`(^|\\s)${s}(\\s|$)`).test(t));
}

/** Production/TV/radio-check audio is never usable as context (a real address inside it is a recap). */
export function isBarrierText(text: string): boolean {
  const t = normalizeText(text);
  if (HARD_PRODUCTION_PHRASES.some((p) => t.includes(p))) return true;
  if (isSignalCountingRun(text)) return true;
  return false;
}

/** A context entry may supply an address only if it is not TV/production audio and not itself a call. */
export function isUsableContextEntry(text: string): boolean {
  if (!text || !text.trim()) return false;
  if (isBarrierText(text)) return false;
  if (containsTvVideoPhrase(text)) return false;
  if (hasDispatchSignalWord(text)) return false; // another call's chunk
  return true;
}

export interface ContextAddressResult {
  address: string;
  crossStreet: string | null;
  /** How many usable context entries were considered. */
  entriesUsed: number;
}

function sameAddressGroup(a: string, b: string): boolean {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  return na.length > 0 && nb.length > 0 && (na.includes(nb) || nb.includes(na));
}

/**
 * Try to find the address of a call in its neighbouring transcripts.
 * `context` is ordered oldest -> newest. Returns null when there is no usable
 * address OR when the usable entries name two different addresses.
 * Single entries and adjacent pairs are tried, so an address split across a
 * chunk boundary ("1234 McKi" + "nley Drive") is recovered from the joined text.
 */
export function backfillAddressFromContext(
  context: readonly string[] | undefined | null,
): ContextAddressResult | null {
  if (!context || context.length === 0) return null;
  const entries = context
    .slice(-CONTEXT_MAX_ENTRIES)
    .map((e) => (typeof e === "string" ? e.slice(0, CONTEXT_MAX_ENTRY_CHARS).trim() : ""))
    .filter(isUsableContextEntry);
  if (entries.length === 0) return null;

  type Cand = { address: string; crossStreet: string | null; pair: boolean };
  const found: Cand[] = [];
  const consider = (text: string, pair: boolean) => {
    const r = extractAddress(text);
    if (r.address && !isInvalidAutoAddress(r.address)) {
      found.push({ address: r.address, crossStreet: r.crossStreet ?? null, pair });
    }
  };
  for (let i = 0; i < entries.length; i++) {
    consider(entries[i], false);
    if (i + 1 < entries.length) consider(`${entries[i]} ${entries[i + 1]}`, true);
  }
  if (found.length === 0) return null;

  // Group candidates that are the same place (one contains the other, e.g.
  // the fragment "nley Drive" and the joined "1234 McKi nley Drive").
  const groups: Cand[][] = [];
  for (const c of found) {
    const g = groups.find((grp) => grp.some((m) => sameAddressGroup(m.address, c.address)));
    if (g) g.push(c);
    else groups.push([c]);
  }
  if (groups.length > 1) return null; // two different addresses: ambiguous, fail closed

  // Pick the cleanest member of the group. A joined pair can pick up a stray
  // word from the neighbouring entry ("clear 4500 West Kennedy Blvd"), so:
  // numbered addresses that START with the house number win, then single-entry
  // results, then the longest.
  const rank = (c: Cand) => (/^\d/.test(c.address) ? 2 : 0) + (c.pair ? 0 : 1);
  const best = groups[0].reduce((a, b) => {
    if (rank(b) !== rank(a)) return rank(b) > rank(a) ? b : a;
    if (b.address.length !== a.address.length) return b.address.length > a.address.length ? b : a;
    return !a.crossStreet && b.crossStreet ? b : a;
  });
  return { address: best.address, crossStreet: best.crossStreet, entriesUsed: entries.length };
}
