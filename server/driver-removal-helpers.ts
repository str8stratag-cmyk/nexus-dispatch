/**
 * Pure helpers for auto/manual removal of drivers from the dispatch group.
 * Owner rule (Zach): require daily check-in, then 30 minutes to share Live
 * Location, or removed from chat. Removal = banChatMember + unbanChatMember
 * (kick; they can rejoin via invite link).
 * Free of Express/Mongo so trial tests can import directly.
 */

export interface RemovalConfig {
  /** DRIVER_LOCATION_GATE=1 AND DRIVER_AUTO_REMOVE=1. */
  autoRemove: boolean;
  /** After tapping check-in, time to start a live share. */
  shareGraceMs: number;
  /** After the daily post, time for seen drivers to check in. */
  checkinDeadlineMs: number;
}

function truthy(v: string | undefined): boolean {
  const s = (v || "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}
function posNum(v: string | undefined, dflt: number): number {
  const n = Number((v ?? "").trim());
  return v != null && v.trim() !== "" && Number.isFinite(n) && n > 0 ? n : dflt;
}

export function readRemovalConfig(env: Record<string, string | undefined> = process.env): RemovalConfig {
  return {
    autoRemove: truthy(env.DRIVER_LOCATION_GATE) && truthy(env.DRIVER_AUTO_REMOVE),
    shareGraceMs: posNum(env.DRIVER_SHARE_GRACE_MIN, 30) * 60_000,
    checkinDeadlineMs: posNum(env.DRIVER_CHECKIN_DEADLINE_MIN, 30) * 60_000,
  };
}

export type RemovalReason = "no_share" | "no_checkin";

/**
 * Decide whether a group member should be auto-removed today.
 * - checked in at `checkinAt`, but no live fix at/after check-in (or already
 *   sharing just before: within `freshMs`) once the grace has passed → no_share
 * - seen in the group today/recently, never checked in, and the daily post
 *   (`postedAt`) is older than the deadline → no_checkin
 */
export function decideAutoRemoval(input: {
  checkinAt: number | null;
  lastLiveFixAt: number | null;
  postedAt: number | null;
  now: number;
  freshMs: number;
  cfg: RemovalConfig;
}): RemovalReason | null {
  const { checkinAt, lastLiveFixAt, postedAt, now, freshMs, cfg } = input;
  if (checkinAt != null) {
    if (now - checkinAt < cfg.shareGraceMs) return null;
    const shared = lastLiveFixAt != null && lastLiveFixAt >= checkinAt - freshMs;
    return shared ? null : "no_share";
  }
  if (postedAt == null) return null;
  return now - postedAt >= cfg.checkinDeadlineMs ? "no_checkin" : null;
}

export interface ChatMemberInfo {
  status?: string; // creator | administrator | member | restricted | left | kicked
  user?: { id?: number; is_bot?: boolean };
}

export type ExemptReason = "admin_id" | "chat_admin" | "bot" | "not_member" | null;

/** Never remove TELEGRAM_ADMIN_IDS, chat admins/creator, bots; skip people no longer in the chat. */
export function exemptionFor(uid: number, member: ChatMemberInfo | null | undefined, admins: Set<number>): ExemptReason {
  if (admins.has(uid)) return "admin_id";
  if (member?.user?.is_bot) return "bot";
  const s = member?.status;
  if (s === "creator" || s === "administrator") return "chat_admin";
  if (s === "left" || s === "kicked") return "not_member";
  return null;
}

/** Telegram error text that means the bot lacks Ban users rights. */
export function isMissingBanRights(description: unknown): boolean {
  const d = String(description ?? "").toLowerCase();
  return d.includes("not enough rights") || d.includes("need administrator rights") || d.includes("chat_admin_required")
    || d.includes("have no rights") || d.includes("bot is not a member");
}

export type RemoveTarget = { kind: "reply"; id: number; name: string } | { kind: "id"; id: number } | { kind: "username"; username: string };

/** Parse "/remove" (reply), "/remove @bob", "/remove 12345", "/remove@Bot ..." → target; null if not /remove; "usage" if bad. */
export function parseRemoveCommand(text: unknown, replyTo?: { from?: { id?: number; username?: string; first_name?: string } } | null): RemoveTarget | "usage" | null {
  if (typeof text !== "string") return null;
  const m = text.trim().match(/^\/remove(?:@\w+)?(?:\s+(.*))?$/i);
  if (!m) return null;
  const arg = (m[1] ?? "").trim();
  if (arg) {
    if (/^\d+$/.test(arg)) return { kind: "id", id: Number(arg) };
    const u = arg.match(/^@?([A-Za-z0-9_]{4,32})$/);
    return u ? { kind: "username", username: u[1].toLowerCase() } : "usage";
  }
  const f = replyTo?.from;
  if (typeof f?.id === "number") {
    return { kind: "reply", id: f.id, name: f.username ? `@${f.username}` : f.first_name || `User ${f.id}` };
  }
  return "usage";
}

export const REMOVE_USAGE = "Usage: reply to the driver's message with /remove, or /remove @username, or /remove <user id>.";

export function reasonText(r: RemovalReason | "manual"): string {
  if (r === "no_share") return "checked in but didn't share Live Location in time";
  if (r === "no_checkin") return "didn't check in";
  return "removed by admin";
}

export function removalNoteText(removed: Array<{ name: string; id: number; reason: RemovalReason | "manual" }>): string {
  return `🚫 Removed from DISPATCH RELAY (${removed.length}):\n` + removed.map((r) => `• ${r.name} (${r.id}) — ${reasonText(r.reason)}`).join("\n");
}

export const MISSING_RIGHTS_NOTE =
  "⚠️ I couldn't remove a driver: I need the 'Ban users' admin permission in DISPATCH RELAY. Group → Manage → Administrators → STGAPPBOT → enable Ban users.";

export type TgApi = (method: string, params: Record<string, unknown>) => Promise<{ ok: boolean; result?: any; description?: string }>;

export type KickResult =
  | { ok: true }
  | { ok: false; why: "exempt"; exempt: Exclude<ExemptReason, null> }
  | { ok: false; why: "no_rights"; description?: string }
  | { ok: false; why: "error"; description?: string };

/**
 * Kick (ban + immediate unban) one user, after exemption checks via getChatMember.
 * Never throws; missing Ban rights comes back as why="no_rights".
 */
export async function kickMember(api: TgApi, chatId: string | number, uid: number, admins: Set<number>): Promise<KickResult> {
  try {
    if (admins.has(uid)) return { ok: false, why: "exempt", exempt: "admin_id" };
    const m = await api("getChatMember", { chat_id: chatId, user_id: uid });
    if (!m.ok) {
      if (isMissingBanRights(m.description)) return { ok: false, why: "no_rights", description: m.description };
      return { ok: false, why: "error", description: m.description };
    }
    const ex = exemptionFor(uid, m.result, admins);
    if (ex) return { ok: false, why: "exempt", exempt: ex };
    const b = await api("banChatMember", { chat_id: chatId, user_id: uid, revoke_messages: false });
    if (!b.ok) {
      return isMissingBanRights(b.description) ? { ok: false, why: "no_rights", description: b.description } : { ok: false, why: "error", description: b.description };
    }
    const u = await api("unbanChatMember", { chat_id: chatId, user_id: uid, only_if_banned: true });
    if (!u.ok) return { ok: false, why: "error", description: `banned but unban failed: ${u.description}` };
    return { ok: true };
  } catch (err: any) {
    return { ok: false, why: "error", description: String(err?.message ?? err) };
  }
}

/** Reply text for a /remove outcome. */
export function removeReplyText(name: string, r: KickResult): string {
  if (r.ok) return `🚫 Removed ${name}. They can rejoin with the invite link.`;
  if (r.why === "exempt") return `Not removed: ${name} is ${r.exempt === "bot" ? "a bot" : r.exempt === "not_member" ? "not in the group" : "an admin"}.`;
  if (r.why === "no_rights") return MISSING_RIGHTS_NOTE;
  return `Couldn't remove ${name}: ${r.description ?? "unknown error"}`;
}
