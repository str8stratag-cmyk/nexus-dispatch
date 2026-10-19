// Pure dispatch-buffer state machine (2026-10-09). No React, no timers, no
// clocks of its own: callers pass `now` and act on what the methods return, so
// every rule is unit-tested with a fake clock (trial/test-dispatch-buffer-core.ts).
// client/src/hooks/use-dispatch-buffer.ts is a thin wrapper that owns the
// setTimeout and calls onDispatch.
//
// Why it exists (DISP-1..5 missed multi-chunk calls, 2026-10-08/09): a call is
// often split across 4 s radio chunks ("signal 4 on" ... "4500 West Kennedy").
// The old buffer flushed 5 s after the last keyword-bearing transcript, so the
// keyword chunk went out without its address and the server quarantined it as
// "requires a resolved address". Now:
//   * a keyword call with NO usable address is HELD (up to holdMs) and keeps
//     collecting chunks; once an address shows up it is sent after a short
//     settle (so "...Kennedy" + "Boulevard" arrive together);
//   * if the hold times out, the call is sent as-is plus `contextTranscripts`
//     (recent unused, keyword-free, non-TV chunks) so the server can still try;
//   * chunks are kept in a timestamped ring (90 s / 16 entries) instead of an
//     unbounded buffer, so stale address-only chunks can no longer ride into
//     the next call.
// Calls that already have an address never wait: they flush exactly like before.

import { extractAddress, containsMajorRoad } from "@shared/extract-address";
import {
  containsTvVideoPhrase,
  isInvalidAutoAddress,
} from "@shared/audio-gates";
import { hasDispatchSignalWord, isBarrierText } from "@shared/address-context";
import { compareHouseNumbers, hasFragmentedHouseNumber } from "@shared/house-number";

/**
 * Join chunk texts and extract the address. When a chunk ends in digits and
 * the next starts with digits ("signal 4 at 37" | "17 Hillsborough Avenue"),
 * the house number was cut at the chunk boundary: also try the numerals glued
 * together and keep that only if it lengthens the house number on the same
 * street (17 -> 3717). Spoken digits ("three seven" | "one seven ...") are
 * handled inside extractAddress itself.
 */
export function extractJoinedAddress(texts: readonly string[]): ReturnType<typeof extractAddress> {
  const transcript = texts.join(" ");
  const ex = extractAddress(transcript);
  if (texts.length < 2) return ex;
  let stitched = texts[0];
  let changed = false;
  for (let i = 1; i < texts.length; i++) {
    const prev = stitched.replace(/[\s,.;:\-]+$/, "");
    const next = texts[i].replace(/^[\s,.;:\-]+/, "");
    const tail = prev.match(/(?:^|\s)(\d{1,3})$/);
    const head = next.match(/^(\d{1,3})(?=\s)/);
    if (tail && head && tail[1].length + head[1].length <= 5) {
      stitched = prev + next;
      changed = true;
    } else {
      stitched = `${stitched} ${texts[i]}`;
    }
  }
  if (!changed) return ex;
  const alt = extractAddress(stitched);
  if (!alt.address) return ex;
  if (!ex.address) return /^\d/.test(alt.address) ? alt : ex;
  // The plain join can keep both groups as "37 17 Hillsborough Ave"; compare
  // with the leading digit groups collapsed so that counts as a fragment.
  const collapsed = ex.address.replace(/^(\d+(?:\s+\d+)+)(?=\s)/, (m) => m.replace(/\s+/g, ""));
  const rel = compareHouseNumbers(ex.address, alt.address);
  return rel === "upgrade" || (collapsed !== ex.address && compareHouseNumbers(collapsed, alt.address) === "same")
    ? { address: alt.address, crossStreet: ex.crossStreet ?? alt.crossStreet }
    : ex;
}

export interface CoreKeyword {
  keyword: string;
  signalType: string;
}

export interface CoreConfig {
  detectKeywords: (text: string) => CoreKeyword[];
  newId?: () => string;
  /** Master switch for the hold. false = old behavior (send immediately, with context). */
  holdEnabled?: boolean;
  silenceMs?: number;
  /** Max chunks joined into one payload (old maxChunks). */
  maxChunks?: number;
  holdMs?: number;
  holdMaxChunks?: number;
  settleMs?: number;
  extendMs?: number;
  holdHardCapMs?: number;
  ringWindowMs?: number;
  ringMax?: number;
  contextMax?: number;
  /** Unused keyword-free chunks this recent before a keyword chunk are still part of the same transmission. */
  precedingJoinMs?: number;
}

export const CORE_DEFAULTS = {
  holdEnabled: true,
  silenceMs: 5_000,
  maxChunks: 6,
  holdMs: 40_000,
  holdMaxChunks: 10,
  settleMs: 3_000,
  extendMs: 15_000,
  holdHardCapMs: 60_000,
  ringWindowMs: 90_000,
  ringMax: 16,
  contextMax: 8,
  precedingJoinMs: 10_000,
} as const;

export interface ChunkMeta {
  /** Client epoch ms the audio of this chunk started/ended (hints only). */
  audioStartedAt?: number;
  audioEndedAt?: number;
}

export interface CorePayload {
  transcript: string;
  keywords: CoreKeyword[];
  address: string | null;
  crossStreet: string | null;
  /** Neighbouring transcripts (oldest -> newest); present when `address` is missing or its house number looks fragmentary. */
  contextTranscripts?: string[];
  /** True when this call went through the address hold. */
  addressHeld: boolean;
  clientRequestId: string;
  audioStartedAt?: number;
  audioEndedAt?: number;
}

interface RingEntry {
  id: number;
  text: string;
  at: number;
  epoch: number;
  hasKeyword: boolean;
  used: boolean;
  audioStartedAt?: number;
  audioEndedAt?: number;
}

type Phase = "idle" | "armed" | "hold";

export interface CoreStats {
  holdsEntered: number;
  holdsResolvedByAddress: number;
  holdTimeouts: number;
  holdSplits: number;
  contextAttached: number;
  barrierChunks: number;
}

/** Crash-related signal types are one incident class; Signal 3 / Signal 16 / Road Mention are their own. */
export function incidentClass(signalType: string | null | undefined): string {
  const s = (signalType || "").toLowerCase().trim();
  if (!s) return "";
  if (s === "signal 3") return "signal3";
  if (s === "signal 16") return "signal16";
  if (s === "road mention") return "road";
  return "crash";
}

export function normalizeAddressKey(address: string | null | undefined): string {
  return (address || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Cooldown helper: a dispatch is a TRUE repeat only when the previous one had
 * the same normalized address AND the same incident class within `windowMs`.
 * A call without an address is never a repeat (it may be the other half of a call).
 */
export function isTrueRepeat(
  prev: { address: string | null; signalType: string | null; at: number } | null,
  next: { address: string | null; signalType: string | null },
  now: number,
  windowMs: number,
): boolean {
  if (!prev) return false;
  if (now - prev.at >= windowMs) return false;
  const a = normalizeAddressKey(prev.address);
  const b = normalizeAddressKey(next.address);
  if (!a || !b || a !== b) return false;
  return incidentClass(prev.signalType) === incidentClass(next.signalType);
}

const INCOMPLETE_TAIL_RE = /\b(at|on|and|by|near|the|of|to|in|off|from|@|&)\s*$/i;
const ADDRESSY_RE = /\b\d{2,5}\b|\b(street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|lane|ln|court|ct|highway|hwy|parkway|pkwy|place|pl|way|circle)\b/i;

/** True when the text ends like an address that is still being spoken ("at", "1234 McKi"). */
export function endsIncomplete(text: string): boolean {
  const t = (text || "").trim().replace(/[.,;:!?]+$/, "");
  if (!t) return false;
  if (INCOMPLETE_TAIL_RE.test(t)) return true;
  const words = t.split(/\s+/);
  const last = words[words.length - 1];
  // A short trailing fragment after a house number looks like a word cut at a chunk boundary.
  if (/^[A-Za-z]{1,4}$/.test(last) && words.some((w) => /^\d{2,5}$/.test(w))) return true;
  return false;
}

/** True when the text looks like part of an address (house number, street suffix, major road). */
export function looksAddressy(text: string): boolean {
  return ADDRESSY_RE.test(text || "") || containsMajorRoad(text || "") || endsIncomplete(text || "");
}

export class DispatchBufferCore {
  private cfg: Required<Omit<CoreConfig, "detectKeywords" | "newId">> & Pick<CoreConfig, "detectKeywords" | "newId">;
  private ring: RingEntry[] = [];
  private nextEntryId = 1;
  private epoch = 0;
  private phase: Phase = "idle";
  private pending: RingEntry[] = [];
  private silenceDeadline = 0;
  private hold = { startedAt: 0, deadline: 0, hardCap: 0, settleDeadline: null as number | null, extended: false };
  private idCounter = 0;
  readonly stats: CoreStats = {
    holdsEntered: 0,
    holdsResolvedByAddress: 0,
    holdTimeouts: 0,
    holdSplits: 0,
    contextAttached: 0,
    barrierChunks: 0,
  };

  constructor(config: CoreConfig) {
    this.cfg = { ...CORE_DEFAULTS, ...config } as DispatchBufferCore["cfg"];
    // Undefined overrides must not erase defaults.
    for (const k of Object.keys(CORE_DEFAULTS) as (keyof typeof CORE_DEFAULTS)[]) {
      if ((this.cfg as any)[k] === undefined) (this.cfg as any)[k] = CORE_DEFAULTS[k];
    }
  }

  // ---- inspection (tests / hook) -------------------------------------------------

  getPhase(): Phase {
    return this.phase;
  }

  getRingTexts(): string[] {
    return this.ring.map((e) => e.text);
  }

  isBusy(): boolean {
    return this.phase !== "idle";
  }

  /** Epoch ms when tick() next needs to run, or null when nothing is scheduled. */
  nextDeadline(): number | null {
    if (this.phase === "armed") return this.silenceDeadline;
    if (this.phase === "hold") return this.holdDue();
    return null;
  }

  // ---- inputs ---------------------------------------------------------------------

  /** A final transcript arrived. Returns payloads to dispatch now (usually none). */
  push(text: string, now: number, meta: ChunkMeta = {}): CorePayload[] {
    const trimmed = (text || "").trim();
    if (!trimmed) return [];
    this.prune(now);
    const out: CorePayload[] = [];

    if (this.isBarrier(trimmed)) {
      // Production/TV/radio-check audio: never part of a call or context, and
      // it separates what came before from what comes after.
      this.stats.barrierChunks++;
      out.push(...this.resolveAll(now));
      this.epoch++;
      return out;
    }

    const entry: RingEntry = {
      id: this.nextEntryId++,
      text: trimmed,
      at: now,
      epoch: this.epoch,
      hasKeyword: this.cfg.detectKeywords(trimmed).length > 0,
      used: false,
      audioStartedAt: meta.audioStartedAt,
      audioEndedAt: meta.audioEndedAt,
    };

    if (this.phase === "hold") {
      out.push(...this.pushDuringHold(entry, now));
      return out;
    }

    this.ring.push(entry);
    this.prune(now);

    if (this.phase === "armed") {
      this.pending.push(entry);
      while (this.pending.length > this.cfg.maxChunks) this.pending.shift();
      this.silenceDeadline = now + this.cfg.silenceMs;
      return out;
    }

    // idle. Same-transmission lead-in: unused keyword-free chunks seconds
    // before this one. The keyword test runs on the JOINED text so a keyword
    // clipped across two chunks ("signal" | "4") still arms, as it always did.
    const lead: RingEntry[] = [];
    for (let i = this.ring.length - 2; i >= 0; i--) {
      const e = this.ring[i];
      if (e.used || e.hasKeyword || e.epoch !== this.epoch) break;
      if (now - e.at > this.cfg.precedingJoinMs) break;
      lead.unshift(e);
      if (lead.length >= this.cfg.maxChunks - 1) break;
    }
    const joinedText = [...lead, entry].map((e) => e.text).join(" ");
    if (!entry.hasKeyword && this.cfg.detectKeywords(joinedText).length === 0) return out;
    this.pending = [...lead, entry];
    this.phase = "armed";
    this.silenceDeadline = now + this.cfg.silenceMs;
    return out;
  }

  /** Time passed. Returns payloads whose timers expired. */
  tick(now: number): CorePayload[] {
    if (this.phase === "armed" && now >= this.silenceDeadline) {
      return this.onSilence(now);
    }
    if (this.phase === "hold" && now >= this.holdDue()) {
      return this.resolveHold(now);
    }
    return [];
  }

  /** Stop / unmount: resolve everything immediately (no waiting for an address). */
  flush(now: number): CorePayload[] {
    return this.resolveAll(now);
  }

  // ---- internals ------------------------------------------------------------------

  private isBarrier(text: string): boolean {
    if (isBarrierText(text)) return true;
    if (containsTvVideoPhrase(text)) {
      // The server lets TV phrases through when the same text is a real call
      // (dispatch signal + valid address); keep that.
      const r = extractAddress(text);
      const real = hasDispatchSignalWord(text) && !!r.address && !isInvalidAutoAddress(r.address);
      return !real;
    }
    return false;
  }

  private prune(now: number): void {
    // Age pruning only while idle: during an armed call or a hold the ring must
    // keep what was said before the call started (the count cap still applies),
    // and context age is measured against the call's first chunk, not "now".
    if (this.phase === "idle") {
      this.ring = this.ring.filter((e) => now - e.at <= this.cfg.ringWindowMs);
    }
    // Entries that are in the pending payload / hold must survive pruning by count.
    while (this.ring.length > this.cfg.ringMax) {
      const idx = this.ring.findIndex((e) => !this.pending.includes(e));
      if (idx === -1) break;
      this.ring.splice(idx, 1);
    }
  }

  private build(chunks: RingEntry[]): Omit<CorePayload, "contextTranscripts" | "addressHeld" | "clientRequestId"> {
    const transcript = chunks.map((c) => c.text).join(" ");
    let keywords = this.cfg.detectKeywords(transcript);
    const ex = extractJoinedAddress(chunks.map((c) => c.text));
    const usable = ex.address && !isInvalidAutoAddress(ex.address);
    // Major road named, no crash keyword -> Road Mention (server decides if it keeps it).
    if (keywords.length === 0 && containsMajorRoad(transcript)) {
      keywords = [{ keyword: "Road Mention", signalType: "Road Mention" }];
    }
    const started = chunks.map((c) => c.audioStartedAt).filter((v): v is number => typeof v === "number");
    const ended = chunks.map((c) => c.audioEndedAt).filter((v): v is number => typeof v === "number");
    return {
      transcript,
      keywords,
      address: usable ? ex.address : null,
      crossStreet: usable ? ex.crossStreet : null,
      audioStartedAt: started.length ? Math.min(...started) : undefined,
      audioEndedAt: ended.length ? Math.max(...ended) : undefined,
    };
  }

  private newRequestId(): string {
    if (this.cfg.newId) return this.cfg.newId();
    this.idCounter++;
    const rnd = Math.random().toString(36).slice(2, 10);
    return `${Date.now().toString(36)}-${this.idCounter}-${rnd}`;
  }

  private selectContext(chunks: RingEntry[], now: number): string[] {
    const inPayload = new Set(chunks.map((c) => c.id));
    const firstAt = Math.min(...chunks.map((c) => c.at));
    const picked = this.ring
      .filter(
        (e) =>
          !inPayload.has(e.id) &&
          !e.used &&
          !e.hasKeyword &&
          e.epoch === this.epoch &&
          firstAt - e.at <= this.cfg.ringWindowMs,
      )
      .filter((e) => !hasDispatchSignalWord(e.text) && !isBarrierText(e.text) && !containsTvVideoPhrase(e.text))
      .slice(-this.cfg.contextMax);
    return picked.map((e) => e.text);
  }

  /** Build the payload for `chunks`, attach context when the address is missing, mark everything used. */
  private emit(chunks: RingEntry[], now: number, addressHeld: boolean): CorePayload[] {
    const base = this.build(chunks);
    if (base.keywords.length === 0) {
      chunks.forEach((c) => (c.used = true));
      return [];
    }
    const payload: CorePayload = { ...base, addressHeld, clientRequestId: this.newRequestId() };
    // Also attach context when the house number looks chopped ("37, 7... 17
    // Hillsborough"): the server may find the full number nearby.
    if (!payload.address || hasFragmentedHouseNumber(payload.transcript, payload.address)) {
      const ctx = this.selectContext(chunks, now);
      if (ctx.length > 0) {
        payload.contextTranscripts = ctx;
        this.stats.contextAttached++;
        for (const e of this.ring) if (ctx.includes(e.text) && !e.used && !e.hasKeyword) e.used = true;
      }
    }
    chunks.forEach((c) => (c.used = true));
    return [payload];
  }

  private onSilence(now: number): CorePayload[] {
    const chunks = this.pending;
    this.pending = [];
    this.phase = "idle";
    const base = this.build(chunks);
    if (base.keywords.length === 0) {
      chunks.forEach((c) => (c.used = true));
      return [];
    }
    if (base.address || !this.cfg.holdEnabled) {
      return this.emit(chunks, now, false);
    }
    // Keyword call with no usable address: hold it and keep collecting.
    this.phase = "hold";
    this.pending = chunks;
    this.hold = {
      startedAt: now,
      deadline: now + this.cfg.holdMs,
      hardCap: now + this.cfg.holdHardCapMs,
      settleDeadline: null,
      extended: false,
    };
    this.stats.holdsEntered++;
    return [];
  }

  private holdDue(): number {
    const h = this.hold;
    if (h.settleDeadline !== null) return Math.min(h.settleDeadline, h.hardCap);
    return Math.min(h.deadline, h.hardCap);
  }

  private holdJoined(): string {
    return this.pending.map((c) => c.text).join(" ");
  }

  private heldKeywords(): CoreKeyword[] {
    return this.cfg.detectKeywords(this.holdJoined());
  }

  private pushDuringHold(entry: RingEntry, now: number): CorePayload[] {
    const out: CorePayload[] = [];
    const ex = extractAddress(entry.text);
    const ownAddress = !!ex.address && !isInvalidAutoAddress(ex.address);

    if (entry.hasKeyword) {
      const newKw = this.cfg.detectKeywords(entry.text);
      const heldClasses = new Set(this.heldKeywords().map((k) => incidentClass(k.signalType)));
      const differentClass = newKw.length > 0 && newKw.every((k) => !heldClasses.has(incidentClass(k.signalType)));
      if (ownAddress && differentClass) {
        // A second, different call arrived while the first was waiting for its address.
        this.stats.holdSplits++;
        out.push(...this.resolveHold(now));
        this.ring.push(entry);
        this.pending = [entry];
        this.phase = "armed";
        this.silenceDeadline = now + this.cfg.silenceMs;
        return out;
      }
    }

    this.ring.push(entry);
    this.pending.push(entry);
    this.prune(now);

    const joined = this.holdJoined();
    const full = extractAddress(joined);
    const haveAddress = !!full.address && !isInvalidAutoAddress(full.address);

    if (haveAddress) {
      // Let a trailing fragment ("Boulevard", "nley Drive") join before sending.
      this.hold.settleDeadline = now + this.cfg.settleMs;
    } else if (!this.hold.extended && (looksAddressy(entry.text) || endsIncomplete(joined))) {
      // Address is plainly mid-sentence: give it a bounded extra window once.
      this.hold.deadline = Math.min(this.hold.deadline + this.cfg.extendMs, this.hold.hardCap);
      this.hold.extended = true;
    }

    if (this.pending.length >= this.cfg.holdMaxChunks && !haveAddress) {
      out.push(...this.resolveHold(now));
    }
    return out;
  }

  /** Send the held call now: with its address if one was found, else as-is with context. */
  private resolveHold(now: number): CorePayload[] {
    const chunks = this.pending;
    const haveAddress = !!this.build(chunks).address;
    this.pending = [];
    this.phase = "idle";
    if (haveAddress) this.stats.holdsResolvedByAddress++;
    else this.stats.holdTimeouts++;
    return this.emit(chunks, now, true);
  }

  private resolveAll(now: number): CorePayload[] {
    if (this.phase === "hold") return this.resolveHold(now);
    if (this.phase === "armed") {
      const chunks = this.pending;
      this.pending = [];
      this.phase = "idle";
      return this.emit(chunks, now, false);
    }
    return [];
  }
}
