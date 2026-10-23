/**
 * Pure helpers for the admin-only /where command (driver last-known location).
 * Free of Express/Mongo so trial tests can import directly.
 */
import { FRESH_LOCATION_MS, formatAge } from "./driver-location-helpers";

/** Parse "/where", "/where@Bot", "/where bob". Returns null if not a /where command. */
export function parseWhereCommand(text: unknown): { query: string } | null {
  if (typeof text !== "string") return null;
  const m = text.trim().match(/^\/where(?:@\w+)?(?:\s+(.*))?$/i);
  if (!m) return null;
  return { query: (m[1] ?? "").trim() };
}

/** Parse TELEGRAM_ADMIN_IDS ("123, 456 789") into a set of numeric user ids. */
export function parseAdminIds(raw: string | null | undefined): Set<number> {
  const out = new Set<number>();
  for (const part of String(raw ?? "").split(/[\s,;]+/)) {
    if (/^\d+$/.test(part)) out.add(Number(part));
  }
  return out;
}

export function isWhereAllowed(fromId: unknown, admins: Set<number>): boolean {
  return typeof fromId === "number" && admins.has(fromId);
}

/** /where works in a private chat with the bot or in the dispatch group. */
export function isWhereChatAllowed(
  chat: { id?: number | string; type?: string } | null | undefined,
  dispatchChatId: string | null | undefined,
): boolean {
  if (!chat || chat.id == null) return false;
  if (chat.type === "private") return true;
  return dispatchChatId != null && String(chat.id).trim() === String(dispatchChatId).trim() && String(chat.id).trim() !== "";
}

export interface WhereDriver {
  telegramUserId: number;
  driverName: string;
  lat: number;
  lon: number;
  at: string; // ISO
}

/** Case-insensitive substring match on name (ignores a leading @). Empty query = everyone. */
export function filterDrivers<T extends WhereDriver>(drivers: T[], query: string): T[] {
  const q = query.replace(/^@/, "").trim().toLowerCase();
  if (!q) return drivers;
  return drivers.filter((d) => d.driverName.replace(/^@/, "").toLowerCase().includes(q));
}

export function mapsLink(lat: number, lon: number): string {
  return `https://maps.google.com/?q=${lat.toFixed(6)},${lon.toFixed(6)}`;
}

export function formatWhereLine(d: WhereDriver, now: number): string {
  const ageMs = now - Date.parse(d.at);
  const tag = ageMs <= FRESH_LOCATION_MS ? "🟢 fresh" : "⚪ STALE";
  return `${d.driverName} — ${formatAge(ageMs)} ago (${tag})\n${mapsLink(d.lat, d.lon)}`;
}

/** Full reply text. Pins (sendLocation) are sent separately when few drivers match. */
export function formatWhereReply(drivers: WhereDriver[], query: string, now: number): string {
  if (drivers.length === 0) {
    return query ? `No driver location found matching "${query}".` : "No driver locations recorded yet.";
  }
  const sorted = [...drivers].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return `📍 Driver locations (${sorted.length}):\n\n` + sorted.map((d) => formatWhereLine(d, now)).join("\n\n");
}

/** Send map pins only for a small result set, to avoid flooding the chat. */
export const WHERE_MAX_PINS = 3;
