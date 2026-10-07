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

/** Backoff delay before retry number `failures` (1-based): initial, doubling, capped. */
export function acceptInitBackoffMs(failures: number, initialMs = 5_000, maxMs = 120_000): number {
  const n = Math.max(1, Math.floor(failures));
  // 2 ** 30 is far past any cap; avoids Infinity for absurd counts.
  return Math.min(initialMs * 2 ** Math.min(n - 1, 30), maxMs);
}

export interface RetryUntilSuccessOptions {
  initialMs?: number;
  maxMs?: number;
  /** Prefix for log lines, e.g. "[telegram] Accept transport setup". */
  label: string;
  log?: (msg: string) => void;
  warn?: (msg: string) => void;
  /** Stop retrying (e.g. process shutdown). Checked before each attempt and wakes a pending wait. */
  signal?: AbortSignal;
  /** Injectable for tests. Must resolve early when `signal` aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    // Never keep the process alive just to retry Telegram setup.
    (t as { unref?: () => void }).unref?.();
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * Run `attempt` until it resolves, retrying thrown errors with exponential
 * backoff (default 5s doubling to a 120s cap), indefinitely. Logs each failure
 * with the next delay, and the success (with the attempt count if it needed
 * retries). Resolves true on success, false if `signal` aborted first.
 * Never rejects.
 */
export async function retryUntilSuccess(
  attempt: () => Promise<void>,
  opts: RetryUntilSuccessOptions,
): Promise<boolean> {
  const initialMs = opts.initialMs ?? 5_000;
  const maxMs = opts.maxMs ?? 120_000;
  const log = opts.log ?? ((m: string) => console.log(m));
  const warn = opts.warn ?? ((m: string) => console.error(m));
  const sleep = opts.sleep ?? abortableSleep;
  for (let n = 1; ; n++) {
    if (opts.signal?.aborted) {
      log(`${opts.label}: stopped before attempt ${n}`);
      return false;
    }
    try {
      await attempt();
      if (n > 1) log(`${opts.label} succeeded on attempt ${n}`);
      return true;
    } catch (err: any) {
      const delay = acceptInitBackoffMs(n, initialMs, maxMs);
      warn(`${opts.label} failed (attempt ${n}): ${err?.message ?? err} — retry in ${delay / 1000}s`);
      await sleep(delay, opts.signal);
    }
  }
}
