import { useEffect, useRef } from "react";
import { detectKeywords } from "@/lib/constants";
import { useKeywords } from "@/hooks/use-keywords";

interface TranscriptEntry {
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

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [entries]);

  return (
    <div
      ref={containerRef}
      className="h-full overflow-y-auto space-y-1 p-2 font-mono text-sm"
      data-testid="transcript-feed"
    >
      {entries.length === 0 && (
        <div className="text-muted-foreground text-xs italic p-4 text-center">
          Waiting for transcription...
        </div>
      )}
      {entries.map((entry) => {
        const keywords = detectKeywords(entry.text, keywordList);
        const hasKeywords = keywords.length > 0;

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
            className={`p-2 rounded text-xs leading-relaxed ${
              hasKeywords
                ? "bg-orange-950/30 border border-orange-900/40"
                : entry.isFinal
                ? "bg-muted/30"
                : "bg-transparent text-muted-foreground"
            }`}
            data-testid={`transcript-entry-${entry.id}`}
          >
            <div className="flex items-start gap-2">
              <span className="text-[10px] text-muted-foreground shrink-0 mt-0.5">
                {new Date(entry.timestamp).toLocaleTimeString("en-US", {
                  hour: "2-digit",
                  minute: "2-digit",
                  second: "2-digit",
                  hour12: false,
                })}
              </span>
              <div className="flex-1">
                <span
                  dangerouslySetInnerHTML={{ __html: highlightedText }}
                  className={entry.isFinal ? "" : "italic"}
                />
                {hasKeywords && (
                  <div className="flex flex-wrap gap-1 mt-1">
                    {keywords.map((kw, i) => (
                      <span
                        key={i}
                        className="inline-flex items-center rounded bg-orange-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-orange-400"
                      >
                        {kw.signalType}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
