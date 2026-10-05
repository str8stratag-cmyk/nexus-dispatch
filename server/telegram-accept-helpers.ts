/**
 * Pure helpers for Telegram Accept-button handling.
 * Kept free of Express/Mongo so trial tests can import without booting the server.
 */

export function parseAcceptCallbackData(data: string | undefined | null): number | null {
  if (!data || !data.startsWith("accept_")) return null;
  const eventId = parseInt(data.slice("accept_".length), 10);
  return Number.isFinite(eventId) ? eventId : null;
}

export function formatTelegramAccepterName(from: {
  id?: number;
  username?: string;
  first_name?: string;
} | undefined | null): string {
  if (!from) return "A driver";
  if (from.username) return `@${from.username}`;
  if (from.first_name) return from.first_name;
  if (from.id != null) return `User ${from.id}`;
  return "A driver";
}

/** True when this process should long-poll Telegram for Accept taps. */
export function isTelegramAcceptPollEnabled(): boolean {
  const v = (process.env.TELEGRAM_ACCEPT_POLL || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}
