import { useState, useRef, useCallback, useEffect } from "react";
import { detectKeywords, type KeywordEntry } from "@/lib/constants";
import {
  DispatchBufferCore,
  type CorePayload,
  type CoreStats,
  type ChunkMeta,
} from "@/lib/dispatch-buffer-core";

// The buffering rules (ring, address hold, context, barriers, double-dispatch
// guard) live in the pure DispatchBufferCore so they can be unit tested; this
// hook only owns the timer and calls onDispatch. See the core's header.

export type DispatchPayload = CorePayload;
export type { ChunkMeta };

interface UseDispatchBufferOptions {
  keywordList: KeywordEntry[];
  onDispatch: (payload: DispatchPayload) => Promise<void>;
  silenceMs?: number;
  maxChunks?: number;
  /** false = old behavior (no address hold). Per-box VITE_ADDRESS_HOLD=off. */
  holdEnabled?: boolean;
  holdMs?: number;
}

export function useDispatchBuffer({
  keywordList,
  onDispatch,
  silenceMs = 5000,
  maxChunks = 6,
  holdEnabled = true,
  holdMs,
}: UseDispatchBufferOptions) {
  const [isPending, setIsPending] = useState(false);
  const keywordListRef = useRef(keywordList);
  keywordListRef.current = keywordList;
  const onDispatchRef = useRef(onDispatch);
  onDispatchRef.current = onDispatch;

  const coreRef = useRef<DispatchBufferCore | null>(null);
  if (coreRef.current === null) {
    coreRef.current = new DispatchBufferCore({
      // Read through a ref so a keyword-list edit applies without rebuilding the buffer.
      detectKeywords: (text) => detectKeywords(text, keywordListRef.current),
      newId: () =>
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
      silenceMs,
      maxChunks,
      holdEnabled,
      holdMs,
    });
  }
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // Send payloads one after another. The core already moved its state on
  // (snapshot-before-await), so a transcript arriving while a dispatch is in
  // flight cannot be folded into, or duplicate, the call being sent.
  const send = useCallback(async (payloads: DispatchPayload[]) => {
    for (const payload of payloads) {
      try {
        await onDispatchRef.current(payload);
      } catch (error) {
        console.error("Dispatch failed:", error);
      }
    }
  }, []);

  const schedule = useCallback(() => {
    clearTimer();
    const core = coreRef.current!;
    const due = core.nextDeadline();
    setIsPending(core.isBusy());
    if (due === null) return;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      const payloads = coreRef.current!.tick(Date.now());
      schedule();
      void send(payloads);
    }, Math.max(0, due - Date.now()));
  }, [clearTimer, send]);

  const addFinalTranscript = useCallback((text: string, meta?: ChunkMeta) => {
    const payloads = coreRef.current!.push(text, Date.now(), meta);
    schedule();
    if (payloads.length > 0) void send(payloads);
  }, [schedule, send]);

  // Stop button / unmount: resolve an armed call or an active hold right away.
  const flush = useCallback(async () => {
    clearTimer();
    const payloads = coreRef.current!.flush(Date.now());
    setIsPending(false);
    await send(payloads);
  }, [clearTimer, send]);

  const getStats = useCallback((): CoreStats => ({ ...coreRef.current!.stats }), []);

  useEffect(() => {
    return () => {
      clearTimer();
      // Best effort: do not lose a call that was waiting for its address.
      const payloads = coreRef.current?.flush(Date.now()) ?? [];
      for (const payload of payloads) {
        void Promise.resolve(onDispatchRef.current(payload)).catch(() => undefined);
      }
    };
  }, [clearTimer]);

  return { addFinalTranscript, flush, isPending, getStats };
}
