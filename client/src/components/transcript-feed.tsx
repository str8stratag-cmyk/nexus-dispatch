import { useEffect, useMemo, useRef, useState } from "react";
import { detectKeywords } from "@/lib/constants";
import { useKeywords } from "@/hooks/use-keywords";
import { clockTime, highlightKeywords, worstSeverity } from "@/lib/monitor-ui";

export interface TranscriptEntry {
  id: string;
  text: string;
  isFinal: boolean;
  timestamp: number;
}

interface TranscriptFeedProps {
  entries: TranscriptEntry[];
  /** Desk/source shown in each row's header (e.g. "DISP-3"). */
  sourceLabel?: string;
  /** Render the Saturday "Live transcripts · newest first" head with the
   *  Detections-only toggle. The legacy stacked AudioPanel supplies its own. */
  showHeader?: boolean;
  /** Clicking a detection row (optional — e.g. select the matching call). */
  onHitClick?: (entry: TranscriptEntry, signalTypes: string[]) => void;
}

export default function TranscriptFeed({ entries, sourceLabel, showHeader = false, onHitClick }: TranscriptFeedProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { keywords: keywordList } = useKeywords();
  const [onlyHits, setOnlyHits] = useState(false);

  // Newest-first: keep the viewport pinned to the top when new items arrive
  // (older entries flow downward). Do not scroll-to-bottom.
  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = 0;
    }
  }, [entries]);

  // Array is oldest→newest from AudioPanel; reverse for newest-on-top UI.
  // Highlighting: `entry.text` is live transcription and keyword labels come
  // from the user-editable keyword/homophone list (Settings panel or
  // /api/keywords), so highlightKeywords() HTML-escapes both and regex-escapes
  // the keyword before building the <mark> markup — otherwise a crafted label
  // (e.g. "<img onerror=...>") would be stored XSS for every viewer, and a
  // pattern like "(a+)+" could ReDoS the highlight regex.
  const rows = useMemo(
    () =>
      [...entries].reverse().map((entry) => {
        const hits = detectKeywords(entry.text, keywordList);
        return {
          entry,
          hits,
          sev: hits.length ? worstSeverity(hits.map((k) => k.signalType)) : null,
          html: highlightKeywords(entry.text, hits.map((k) => k.keyword)),
        };
      }),
    [entries, keywordList],
  );
  const visible = onlyHits ? rows.filter((r) => r.hits.length > 0) : rows;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="transcript-feed-wrap">
      {showHeader && (
        <div className="sat-fhead">
          <span>Live transcripts · newest first</span>
          <button
            type="button"
            className={onlyHits ? "on" : ""}
            aria-pressed={onlyHits}
            onClick={() => setOnlyHits((v) => !v)}
            data-testid="transcript-detections-only"
          >
            Detections only
          </button>
        </div>
      )}
      <div ref={containerRef} className="sat-flist" data-testid="transcript-feed">
        {visible.length === 0 && (
          <div className="sat-empty">{onlyHits && rows.length > 0 ? "No detections yet" : "Waiting for transcription…"}</div>
        )}
        {visible.map(({ entry, hits, sev, html }) => {
          const isHit = hits.length > 0;
          const cls = ["sat-tx", isHit ? `hit ${sev}` : "chatter", entry.isFinal ? "" : "interim"].join(" ");
          const signals = hits.map((k) => k.signalType);
          const body = (
            <>
              <div className="t">
                <span>
                  {clockTime(entry.timestamp)}
                  {sourceLabel ? ` · ${sourceLabel}` : ""}
                </span>
                {isHit && <span>{Array.from(new Set(signals)).join(" · ")}</span>}
              </div>
              <span dangerouslySetInnerHTML={{ __html: html }} />
            </>
          );
          return isHit && onHitClick ? (
            <button
              key={entry.id}
              type="button"
              className={cls}
              onClick={() => onHitClick(entry, signals)}
              data-testid={`transcript-entry-${entry.id}`}
            >
              {body}
            </button>
          ) : (
            <div key={entry.id} className={cls} data-testid={`transcript-entry-${entry.id}`}>
              {body}
            </div>
          );
        })}
      </div>
    </div>
  );
}
