/**
 * Pure helpers for live-location check-in and the continuous membership gate.
 *
 * Check-in is sharing a Telegram Live Location (group or private chat with the
 * bot). The continuous gate (DRIVER_LIVE_GATE, off by default) approves join
 * requests, removes new members who don't start a live share in time, and
 * warns once then removes drivers whose live share stops, expires, or goes
 * stale. Free of Express/Mongo so trial tests can import directly.
 *
 * This is separate from the daily check-in button (DRIVER_LOCATION_GATE).
 * Dispatch alerts still post to the group; this module never routes calls.
 */
import { liveShareEndsAt } from "./driver-checkin-helpers";
import { isDispatchGroupChat } from "./driver-location-helpers";
import { parseAdminIds } from "./telegram-where-helpers";

export interface LiveGateConfig {
  /** DRIVER_LIVE_GATE=1. Off unless explicitly enabled. */
  enabled: boolean;
  /** New member must start a live share within this window. Default 10 min. */
  joinGraceMs: number;
  /** Last live fix older than this counts as stale. Default 15 min. */
  staleMs: number;
  /** After the one warning, time to re-share before removal. Default 5 min. */
  resumeGraceMs: number;
  /** Telegram user ids that are never warned or removed. */
  exemptIds: Set<number>;
}

function truthy(v: string | undefined): boolean {
  const s = (v || "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

function posNum(v: string | undefined, dflt: number): number {
  const n = Number((v ?? "").trim());
  return v != null && v.trim() !== "" && Number.isFinite(n) && n > 0 ? n : dflt;
}

export function readLiveGateConfig(env: Record<string, string | undefined> = process.env): LiveGateConfig {
  return {
    enabled: truthy(env.DRIVER_LIVE_GATE),
    joinGraceMs: posNum(env.DRIVER_JOIN_GRACE_MIN, 10) * 60_000,
    staleMs: posNum(env.DRIVER_LIVE_STALE_MIN, 15) * 60_000,
    resumeGraceMs: posNum(env.DRIVER_RESUME_GRACE_MIN, 5) * 60_000,
    exemptIds: parseAdminIds(env.DRIVER_LIVE_EXEMPT_IDS),
  };
}

/** Enforcement config: DRIVER_LIVE_EXEMPT_IDS plus TELEGRAM_ADMIN_IDS. */
export function effectiveLiveGateConfig(env: Record<string, string | undefined> = process.env): LiveGateConfig {
  const cfg = readLiveGateConfig(env);
  const exemptIds = new Set(cfg.exemptIds);
  for (const id of Array.from(parseAdminIds(env.TELEGRAM_ADMIN_IDS))) exemptIds.add(id);
  return { ...cfg, exemptIds };
}

export function graceMinutes(ms: number): number {
  return Math.max(1, Math.round(ms / 60_000));
}

/** Exact check-in confirmation. `<name>` is the driver's Telegram name. */
export function checkinReplyText(name: string): string {
  return `✅ ${name} checked in — receiving calls.`;
}

/** Exact warning sentence. `resumeMin` is the configured resume grace (default 5). */
export function locationStoppedWarning(resumeMin: number): string {
  return `Your location stopped — re-share within ${resumeMin} min or you'll be removed`;
}

export function locationStoppedNotice(name: string, resumeMin: number): string {
  return `${name}: ${locationStoppedWarning(resumeMin)}`;
}

export function joinWelcomeText(name: string, joinMin: number, exempt: boolean): string {
  if (exempt) {
    return `${name} joined. Live-location check-in is optional for this account. Share Live Location (📎 → Location → Share My Live Location → "Until I turn it off") here or privately to this bot to check in.`;
  }
  return [
    `${name} joined. Share your Live Location within ${joinMin} min or you'll be removed.`,
    `📎 → Location → Share My Live Location → "Until I turn it off".`,
    `You can share it in this group or privately to this bot.`,
  ].join("\n");
}

export function removalNotice(name: string, id: number, reason: GateReason): string {
  const why = reason === "no_share"
    ? "didn't share Live Location in time after joining"
    : "Live Location stopped and was not re-shared in time";
  return `🚫 Removed from DISPATCH RELAY: ${name} (${id}) — ${why}. They can rejoin with the invite link.`;
}

export type LocationKind = "live" | "stop" | "static";

/**
 * Live updates carry `live_period` (first share is a message, later fixes are
 * edited_message). Stopping a live share edits that message and drops
 * `live_period`. A brand-new message without `live_period` is a static pin.
 */
export function classifyLocationUpdate(update: any): LocationKind | null {
  const edited = update?.edited_message?.location ? update.edited_message : null;
  const message = !edited && update?.message?.location ? update.message : null;
  const msg = edited ?? message;
  if (!msg) return null;
  const live = msg.location?.live_period;
  if (typeof live === "number" && Number.isFinite(live)) return "live";
  if (edited) return "stop";
  return "static";
}

export function isPrivateChat(update: any): boolean {
  const chat = update?.message?.chat ?? update?.edited_message?.chat ?? update?.chat_join_request?.chat;
  return chat?.type === "private";
}

/**
 * Group locations are always stored (existing driver board). A private chat
 * with the bot counts only while the gate is on, and only for a live share
 * or an explicit stop — not a one-shot pin.
 */
export function acceptsLocationChat(
  chatId: string | null | undefined,
  update: any,
  dispatchChatId: string | null | undefined,
  gateEnabled: boolean,
): boolean {
  if (isDispatchGroupChat(chatId, dispatchChatId)) return true;
  if (!gateEnabled || !isPrivateChat(update)) return false;
  const kind = classifyLocationUpdate(update);
  return kind === "live" || kind === "stop";
}

/** getUpdates / setWebhook types. Join requests are requested only while the gate is on. */
export function telegramAllowedUpdates(gateEnabled: boolean): string[] {
  const base = ["callback_query", "message", "edited_message"];
  return gateEnabled ? [...base, "chat_join_request"] : base;
}

export interface JoinRequestInfo {
  chatId: string;
  userId: number;
  name: string;
  username: string | null;
  isBot: boolean;
}

export function parseJoinRequest(update: any): JoinRequestInfo | null {
  const req = update?.chat_join_request;
  if (!req || typeof req.from?.id !== "number" || req.chat?.id == null) return null;
  const from = req.from;
  const name = from.username
    ? `@${from.username}`
    : [from.first_name, from.last_name].filter(Boolean).join(" ") || `User ${from.id}`;
  return {
    chatId: String(req.chat.id),
    userId: from.id,
    name,
    username: typeof from.username === "string" ? from.username : null,
    isBot: Boolean(from.is_bot),
  };
}

/** approveChatJoinRequest failed because they are already in the group. */
export function isAlreadyParticipant(description: unknown): boolean {
  const d = String(description ?? "").toLowerCase();
  return d.includes("user_already_participant")
    || d.includes("already a participant")
    || d.includes("user_already_member");
}

export interface LiveGateState {
  telegramUserId: number;
  driverName: string;
  joinedAt: number | null;
  checkedIn: boolean;
  isLive: boolean;
  liveStartedAt: number | null;
  livePeriod: number | null;
  lastFixAt: number | null;
  stoppedAt: number | null;
  warnedAt: number | null;
  removedAt: number | null;
  /** Chat admin / already gone: stop retrying the kick every sweep. */
  hold: "exempt" | null;
  /**
   * Increments on every transition into an active live share.
   * Warn/remove claims are pinned to the gen the sweep observed, so a
   * resume can't be overwritten by a stale claim (and vice versa).
   */
  shareGen: number;
  lat: number | null;
  lon: number | null;
  liveChatId: string | null;
  liveMessageId: number | null;
}

export function blankLiveState(telegramUserId: number, driverName: string): LiveGateState {
  return {
    telegramUserId,
    driverName,
    joinedAt: null,
    checkedIn: false,
    isLive: false,
    liveStartedAt: null,
    livePeriod: null,
    lastFixAt: null,
    stoppedAt: null,
    warnedAt: null,
    removedAt: null,
    hold: null,
    shareGen: 0,
    lat: null,
    lon: null,
    liveChatId: null,
    liveMessageId: null,
  };
}

export type ShareHealth = "active" | "stopped" | "expired" | "stale" | "none";

export function shareHealth(
  s: Pick<LiveGateState, "checkedIn" | "isLive" | "stoppedAt" | "livePeriod" | "liveStartedAt" | "lastFixAt">,
  now: number,
  staleMs: number,
): ShareHealth {
  if (!s.checkedIn && !s.isLive) return "none";
  if (!s.isLive || s.stoppedAt != null) return "stopped";
  const ends = liveShareEndsAt({
    livePeriod: s.livePeriod,
    at: s.lastFixAt ?? s.liveStartedAt ?? now,
    liveStartedAt: s.liveStartedAt,
  });
  if (ends != null && now >= ends) return "expired";
  if (s.lastFixAt == null || now - s.lastFixAt > staleMs) return "stale";
  return "active";
}

export function fixIsActive(
  fix: { at: number; livePeriod: number | null; liveStartedAt: number | null },
  now: number,
  staleMs: number,
): boolean {
  if (fix.livePeriod == null) return false;
  const ends = liveShareEndsAt({
    livePeriod: fix.livePeriod,
    at: fix.at,
    liveStartedAt: fix.liveStartedAt,
  });
  if (ends != null && now >= ends) return false;
  return now - fix.at <= staleMs;
}

export interface LocationFixInput {
  userId: number;
  driverName: string;
  at: number;
  livePeriod: number | null;
  liveStartedAt: number | null;
  lat?: number | null;
  lon?: number | null;
  liveChatId?: string | null;
  liveMessageId?: number | null;
}

/**
 * Fold one location update into driver state.
 * Returns null for a static pin, a stop we have no prior state for, or a
 * live update that is already expired when nobody was checked in.
 * `announce` is true only on the transition into an active live share.
 */
export function reduceLocation(
  prev: LiveGateState | null,
  kind: LocationKind,
  fix: LocationFixInput,
  now: number,
  staleMs: number,
): { state: LiveGateState; announce: boolean } | null {
  const coords = {
    lat: fix.lat ?? prev?.lat ?? null,
    lon: fix.lon ?? prev?.lon ?? null,
    liveChatId: fix.liveChatId ?? prev?.liveChatId ?? null,
    liveMessageId: fix.liveMessageId ?? prev?.liveMessageId ?? null,
  };

  if (kind === "static") return null;

  if (kind === "stop") {
    if (!prev) return null;
    return {
      announce: false,
      state: {
        ...prev,
        ...coords,
        driverName: fix.driverName || prev.driverName,
        isLive: false,
        stoppedAt: prev.stoppedAt ?? fix.at,
        lastFixAt: fix.at,
      },
    };
  }

  if (!fixIsActive(fix, now, staleMs)) {
    if (!prev?.checkedIn) return null;
    return {
      announce: false,
      state: {
        ...prev,
        ...coords,
        driverName: fix.driverName || prev.driverName,
        isLive: false,
        stoppedAt: prev.stoppedAt ?? now,
        lastFixAt: fix.at,
        livePeriod: fix.livePeriod,
        liveStartedAt: fix.liveStartedAt,
      },
    };
  }

  const wasActive = prev != null
    && prev.checkedIn
    && prev.isLive
    && prev.stoppedAt == null
    && prev.warnedAt == null
    && shareHealth(prev, now, staleMs) === "active";

  const base = prev ?? blankLiveState(fix.userId, fix.driverName);
  return {
    announce: !wasActive,
    state: {
      ...base,
      ...coords,
      telegramUserId: fix.userId,
      driverName: fix.driverName || base.driverName,
      checkedIn: true,
      isLive: true,
      liveStartedAt: fix.liveStartedAt,
      livePeriod: fix.livePeriod,
      lastFixAt: fix.at,
      stoppedAt: null,
      warnedAt: null,
      removedAt: null,
      hold: null,
      shareGen: (prev?.shareGen ?? 0) + (wasActive ? 0 : 1),
    },
  };
}

/**
 * New join. An already-active live share is left alone (no new deadline).
 * Otherwise the 10-minute share clock starts now — not at the request's
 * original date — so a backlog isn't kicked the moment it is approved.
 */
export function applyJoin(
  prev: LiveGateState | null,
  userId: number,
  name: string,
  now: number,
  cfg: LiveGateConfig,
): { state: LiveGateState; welcome: boolean } {
  if (prev && shareHealth(prev, now, cfg.staleMs) === "active") {
    return { state: { ...prev, driverName: name || prev.driverName }, welcome: false };
  }
  const base = prev ?? blankLiveState(userId, name);
  return {
    welcome: true,
    state: {
      ...base,
      telegramUserId: userId,
      driverName: name || base.driverName,
      joinedAt: now,
      checkedIn: false,
      isLive: false,
      liveStartedAt: null,
      livePeriod: null,
      lastFixAt: null,
      stoppedAt: null,
      warnedAt: null,
      removedAt: null,
      hold: null,
      shareGen: 0,
      lat: null,
      lon: null,
      liveChatId: null,
      liveMessageId: null,
    },
  };
}

export type GateReason = "no_share" | "stopped" | "expired" | "stale";

export type GateAction =
  | { action: "none" }
  | { action: "warn"; reason: Exclude<GateReason, "no_share"> }
  | { action: "remove"; reason: GateReason };

/**
 * One sweep decision.
 * - Not checked in, and the join clock has run out → remove (no prior warning).
 * - Checked in, but the share stopped / expired / went stale → warn once,
 *   then remove if it is still down when the resume grace ends.
 * - Exempt ids, held accounts, and anyone already removed → none.
 * - Flag off → none.
 */
export function decideGateAction(s: LiveGateState, now: number, cfg: LiveGateConfig): GateAction {
  if (!cfg.enabled) return { action: "none" };
  if (cfg.exemptIds.has(s.telegramUserId)) return { action: "none" };
  if (s.hold === "exempt") return { action: "none" };
  if (s.removedAt != null) return { action: "none" };

  if (!s.checkedIn) {
    if (s.joinedAt == null) return { action: "none" };
    if (now - s.joinedAt >= cfg.joinGraceMs) return { action: "remove", reason: "no_share" };
    return { action: "none" };
  }

  const health = shareHealth(s, now, cfg.staleMs);
  if (health === "active" || health === "none") return { action: "none" };
  if (s.warnedAt == null) return { action: "warn", reason: health };
  if (now - s.warnedAt >= cfg.resumeGraceMs) return { action: "remove", reason: health };
  return { action: "none" };
}
