import { useState, useRef, useCallback, useEffect } from "react";
import { detectKeywords, type KeywordEntry } from "@/lib/constants";
import { extractAddress, type ExtractedAddress } from "@/lib/extract-address";

export interface DispatchPayload {
  transcript: string;
  keywords: { keyword: string; signalType: string }[];
  address: string | null;
  crossStreet: string | null;
}

interface UseDispatchBufferOptions {
  keywordList: KeywordEntry[];
  onDispatch: (payload: DispatchPayload) => Promise<void>;
  silenceMs?: number;
  maxChunks?: number;
}

export function useDispatchBuffer({
  keywordList,
  onDispatch,
  silenceMs = 5000,
  maxChunks = 6,
}: UseDispatchBufferOptions) {
  const [isPending, setIsPending] = useState(false);
  const bufferRef = useRef<string[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const buildPayload = useCallback((chunks: string[]): DispatchPayload & ExtractedAddress => {
    const transcript = chunks.join(" ");
    const keywords = detectKeywords(transcript, keywordList);
    const { address, crossStreet } = extractAddress(transcript);
    return { transcript, keywords, address, crossStreet };
  }, [keywordList]);

  const addFinalTranscript = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    // 1. Add to rolling buffer (keep max `maxChunks`)
    bufferRef.current.push(trimmed);
    if (bufferRef.current.length > maxChunks) {
      bufferRef.current.shift();
    }

    // 2. Evaluate the *combined buffer* for keywords. This is critical for
    // clipped calls where a keyword is split across final transcript chunks.
    const fullTranscript = bufferRef.current.join(" ");
    const allKeywords = detectKeywords(fullTranscript, keywordList);

    if (allKeywords.length > 0) {
      setIsPending(true);

      // 3. Reset the silence timer
      clearTimer();
      timerRef.current = setTimeout(async () => {
        const finalChunks = bufferRef.current;
        const { transcript, keywords, address, crossStreet } = buildPayload(finalChunks);

        if (keywords.length > 0) {
          try {
            await onDispatch({ transcript, keywords, address, crossStreet });
          } catch (error) {
            console.error("Dispatch failed:", error);
          }
        }

        // 4. Reset state
        bufferRef.current = [];
        setIsPending(false);
      }, silenceMs);
    }
  }, [keywordList, maxChunks, silenceMs, clearTimer, buildPayload, onDispatch]);

  const flush = useCallback(async () => {
    if (!isPending || !timerRef.current) return;

    clearTimeout(timerRef.current);
    timerRef.current = null;

    const finalChunks = bufferRef.current;
    const { transcript, keywords, address, crossStreet } = buildPayload(finalChunks);

    if (keywords.length > 0) {
      try {
        await onDispatch({ transcript, keywords, address, crossStreet });
      } catch (error) {
        console.error("Dispatch flush failed:", error);
      }
    }

    bufferRef.current = [];
    setIsPending(false);
  }, [isPending, buildPayload, onDispatch, clearTimer]);

  useEffect(() => {
    return () => clearTimer();
  }, [clearTimer]);

  return { addFinalTranscript, flush, isPending };
}
