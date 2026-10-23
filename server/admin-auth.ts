/**
 * Pure helpers for admin auth: PIN format validation, constant-time
 * comparison, and per-IP brute-force lockout. Kept free of Express so trial
 * tests can import without booting the server.
 */
import { timingSafeEqual } from "node:crypto";

/** ADMIN_SECRET is a 4-digit PIN the owner sets per desk; never generated/guessed here. */
export const ADMIN_SECRET_FORMAT = /^\d{4}$/;

export function isValidAdminSecretFormat(secret: string | undefined): boolean {
  return !!secret && ADMIN_SECRET_FORMAT.test(secret);
}

/**
 * Constant-time string compare. timingSafeEqual throws on mismatched buffer
 * lengths, so a length mismatch still runs a same-cost dummy comparison
 * before returning false, rather than short-circuiting immediately.
 */
export function secureCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export const LOCKOUT_MAX_ATTEMPTS = 5;
export const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;

interface LockoutEntry {
  failures: number;
  lockedUntil: number | null;
}

/** Per-IP brute-force lockout: maxAttempts wrong attempts locks that IP out for windowMs. */
export class LoginLockout {
  private entries = new Map<string, LockoutEntry>();

  constructor(
    private maxAttempts = LOCKOUT_MAX_ATTEMPTS,
    private windowMs = LOCKOUT_WINDOW_MS,
    private now: () => number = Date.now,
  ) {}

  /** Returns remaining lockout ms if currently locked out, else null. */
  checkLocked(key: string): number | null {
    const entry = this.entries.get(key);
    if (!entry?.lockedUntil) return null;
    const remaining = entry.lockedUntil - this.now();
    if (remaining <= 0) {
      this.entries.delete(key);
      return null;
    }
    return remaining;
  }

  recordFailure(key: string): void {
    const entry = this.entries.get(key) ?? { failures: 0, lockedUntil: null };
    entry.failures++;
    if (entry.failures >= this.maxAttempts) {
      entry.lockedUntil = this.now() + this.windowMs;
    }
    this.entries.set(key, entry);
  }

  recordSuccess(key: string): void {
    this.entries.delete(key);
  }
}
