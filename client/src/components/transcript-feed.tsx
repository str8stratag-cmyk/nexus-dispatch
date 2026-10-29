import { useEffect, useRef, useState } from "react";
import { detectKeywords } from "@/lib/constants";
import { useKeywords } from "@/hooks/use-keywords";
import { signalSeverity, SEVERITY_BORDER } from "@/lib/signal-severity";

export interface TranscriptEntry {
  id: string;
  text: string;
  isFinal: boolean;
  timestamp: number;
}

interface TranscriptFeedProps {
  entries: TranscriptEntry[];
}

// Escapes HTML-significant characters so untrusted text can be safely
// embedded inside dangerouslySetInnerHTML.
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Escapes regex metacharacters so untrusted text can be safely interpolated
// into a `new RegExp(...)` pattern without altering matching semantics or
// enabling catastrophic-backtracking (ReDoS) patterns.
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export default function TranscriptFeed({ entries }: TranscriptFeedProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { keywords: keywordList } = useKeywords();
  const [detectionsOnly, setDetectionsOnly] = useState(false);

  // Newest-first: keep the viewport pinned to the top when new items arrive
  // (older entries flow downward). Do not scroll-to-bottom.
  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = 0;
    }
  }, [entries]);

  // Oldest->newest from AudioPanel; reverse for newest-on-top UI, then apply
  // the detections-only filter (Saturday UI parity).
  const rows = [...entries].reverse().filter((entry) => {
    if (!detectionsOnly) return true;
    return detectKeywords(entry.text, keywordList).length > 0;
  });

  return (
    <div className="flex h-full flex-col" data-testid="transcript-feed">
      <div className="flex shrink-0 items-center justify-between border-b border-border px-2.5 py-1.5">
        <span className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
          Live transcripts · newest first
        </span>
        <button
          type="button"
          onClick={() => setDetectionsOnly((v) => !v)}
          className={`rounded-md border px-2 py-0.5 text-xs font-medium transition-colors ${
            detectionsOnly
              ? "border-primary bg-primary text-primary-foreground"
              : "border-border text-muted-foreground hover:text-foreground"
          }`}
          data-testid="transcript-detections-only"
        >
          Detections only
        </button>
      </div>
      <div ref={containerRef} className="flex-1 overflow-y-auto space-y-2 p-3 font-mono text-sm lg:text-[15px]">
        {rows.length === 0 && (
          <div className="text-muted-foreground text-sm italic p-4 text-center">
            {detectionsOnly ? "No detections yet" : "Waiting for transcription..."}
          </div>
        )}
        {rows.map((entry) => {
          const keywords = detectKeywords(entry.text, keywordList);
          const hasKeywords = keywords.length > 0;
          const sev = hasKeywords ? signalSeverity(keywords[0]?.signalType) : null;

          // Highlight keywords in the transcript. `entry.text` is live
          // transcription and `kw.keyword` ultimately derives from the
          // user-editable keyword/homophone list (Settings panel or
          // /api/keywords), so both must be HTML-escaped before being placed
          // in dangerouslySetInnerHTML — otherwise a crafted label/pattern
          // (e.g. containing "<img onerror=...>") would execute as stored
          // XSS for every viewer of the feed. Regex metacharacters in the
          // keyword are also escaped so a pattern like "(a+)+" can't be used
          // for a ReDoS attack via the highlight regex.
          let highlightedText = escapeHtml(entry.text);
          if (hasKeywords) {
            keywords.forEach((kw) => {
              const safeKeyword = escapeRegExp(escapeHtml(kw.keyword));
              const regex = new RegExp(`(${safeKeyword})`, "gi");
              highlightedText = highlightedText.replace(
                regex,
                `<mark class="bg-orange-500/30 text-orange-300 rounded px-0.5">$1</mark>`
              );
            });
          }

          return (
            <div
              key={entry.id}
              className={`rounded border-l-[3px] bg-muted/20 px-3 py-2 leading-relaxed ${
                hasKeywords && sev
                  ? `${SEVERITY_BORDER[sev]} bg-orange-950/20`
                  : entry.isFinal
                  ? "border-l-border"
                  : "border-l-transparent text-muted-foreground"
              }`}
              data-testid={`transcript-entry-${entry.id}`}
            >
              <div className="mb-1 text-xs text-muted-foreground">
                {new Date(entry.timestamp).toLocaleTimeString("en-US", {
                  hour: "2-digit",
                  minute: "2-digit",
                  second: "2-digit",
                  hour12: false,
                })}
              </div>
              <span
                dangerouslySetInnerHTML={{ __html: highlightedText }}
                className={entry.isFinal ? "" : "italic"}
              />
              {hasKeywords && (
                <div className="flex flex-wrap gap-1 mt-1">
                  {keywords.map((kw, i) => (
                    <span
                      key={i}
                      className="inline-flex items-center rounded bg-orange-500/20 px-1.5 py-0.5 text-xs font-semibold text-orange-400"
                    >
                      {kw.signalType}
                    </span>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
