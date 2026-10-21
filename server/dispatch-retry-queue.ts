// Durable retry queue for POST /api/dispatch (2026-10-21).
//
// DISP-1, 11:02 AM ET 10/21: a Signal call hit `querySrv ETIMEOUT` (Mongo SRV
// DNS lookup failed during the fleet-wide connection drop). The handler
// returned 400 after 82 s and the call was gone: nothing retried it and it
// never reached quarantine. Now a dispatch that fails with a transient
// Mongo/network error is appended to a local file queue and replayed with
// backoff until it gets a definitive answer. The replay goes back through the
// normal /api/dispatch handler, so validation, dedup (against events created
// meanwhile, e.g. by another desk) and the address gates all apply as usual.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** Header the replayer sets so a still-failing replay answers 503 instead of re-queueing. */
export const DISPATCH_RETRY_HEADER = "x-dm-dispatch-retry";

const TRANSIENT_PATTERNS = [
  /querySrv/i,
  /\bE(TIMEOUT|TIMEDOUT|NOTFOUND|CONNREFUSED|CONNRESET|AI_AGAIN|PIPE|NETUNREACH|HOSTUNREACH)\b/,
  /server selection timed out/i,
  /MongoNetwork/i,
  /MongoServerSelection/i,
  /MongoNotConnected/i,
  /Topology is closed/i,
  /connection .* (closed|timed out)/i,
  /socket hang up/i,
  /getaddrinfo/i,
  /pool (was )?(cleared|closed)/i,
];

/** A Mongo/network failure worth retrying (as opposed to a validation/logic error). */
export function isTransientDbError(err: unknown): boolean {
  if (!err) return false;
  const e = err as { name?: unknown; code?: unknown; message?: unknown; cause?: unknown };
  if (e.name === "ZodError") return false;
  const name = typeof e.name === "string" ? e.name : "";
  if (/^Mongo(Network|ServerSelection|NotConnected|Topology)/.test(name)) return true;
  const text = `${name} ${typeof e.code === "string" ? e.code : ""} ${typeof e.message === "string" ? e.message : String(err)}`;
  if (TRANSIENT_PATTERNS.some((re) => re.test(text))) return true;
  return e.cause ? isTransientDbError(e.cause) : false;
}

export interface QueuedDispatch {
  id: string;
  body: Record<string, unknown>;
  queuedAt: number;
  attempts: number;
  nextAt: number;
  lastError: string | null;
}

export const RETRY_BASE_MS = 15_000;
export const RETRY_MAX_MS = 10 * 60_000;
/** Give up (move to the dead-letter file) after this long; a call older than this is stale for dispatch. */
export const RETRY_MAX_AGE_MS = 24 * 60 * 60_000;

export function retryDelayMs(attempts: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1));
}

export type ReplayOutcome = "done" | "retry";

/**
 * File-backed queue. The whole queue is rewritten atomically (tmp + rename)
 * on every change; it is tiny (only calls made during an outage).
 */
export class DispatchRetryQueue {
  private items: QueuedDispatch[] = [];
  private draining = false;

  constructor(private readonly file: string, private readonly now: () => number = Date.now) {
    this.load();
  }

  private load(): void {
    try {
      if (!existsSync(this.file)) return;
      const raw = JSON.parse(readFileSync(this.file, "utf8"));
      if (Array.isArray(raw)) this.items = raw.filter((x) => x && typeof x.id === "string" && x.body && typeof x.body === "object");
    } catch (err) {
      // Never lose a corrupt queue silently: keep it aside for manual recovery.
      console.error("[dispatch-retry] queue file unreadable, moving aside:", err);
      try {
        renameSync(this.file, `${this.file}.corrupt-${this.now()}`);
      } catch {
        // ignore
      }
      this.items = [];
    }
  }

  private save(): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.items));
    renameSync(tmp, this.file);
  }

  get size(): number {
    return this.items.length;
  }

  list(): readonly QueuedDispatch[] {
    return this.items;
  }

  /** Persist a failed dispatch. Returns the queue id. */
  enqueue(body: Record<string, unknown>, err: unknown): string {
    const now = this.now();
    const { _id: _ignored, ...clean } = body as Record<string, unknown> & { _id?: unknown };
    const item: QueuedDispatch = {
      id: randomUUID(),
      body: clean,
      queuedAt: now,
      attempts: 0,
      nextAt: now + RETRY_BASE_MS,
      lastError: String((err as Error)?.message ?? err).slice(0, 300),
    };
    this.items.push(item);
    this.save();
    return item.id;
  }

  /**
   * Replay due items one at a time. `send` must resolve "done" when the
   * server gave a definitive answer (created, duplicate, or rejected/quarantined)
   * and "retry" on another transient failure. Exceptions count as "retry".
   */
  async drain(send: (item: QueuedDispatch) => Promise<ReplayOutcome>, onDeadLetter?: (item: QueuedDispatch) => void): Promise<number> {
    if (this.draining) return 0;
    this.draining = true;
    let done = 0;
    try {
      for (const item of [...this.items]) {
        const now = this.now();
        if (now - item.queuedAt > RETRY_MAX_AGE_MS) {
          onDeadLetter?.(item);
          this.items = this.items.filter((x) => x.id !== item.id);
          this.save();
          continue;
        }
        if (item.nextAt > now) continue;
        let outcome: ReplayOutcome = "retry";
        try {
          outcome = await send(item);
        } catch (err) {
          item.lastError = String((err as Error)?.message ?? err).slice(0, 300);
        }
        if (outcome === "done") {
          this.items = this.items.filter((x) => x.id !== item.id);
          done++;
        } else {
          item.attempts++;
          item.nextAt = this.now() + retryDelayMs(item.attempts);
          // Stop this pass: the backend is still down, don't hammer it.
          this.save();
          break;
        }
        this.save();
      }
    } finally {
      this.draining = false;
    }
    return done;
  }
}
