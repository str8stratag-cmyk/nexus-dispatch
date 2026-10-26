import { useEventActions } from "@/hooks/use-event-actions";
import { useKeywords } from "@/hooks/use-keywords";
import { detectKeywords } from "@/lib/constants";
import { NEEDS_REVIEW_STATUS } from "@shared/review-event";
import {
  ago,
  eventKeywordLabels,
  formatAddress,
  highlightKeywords,
  signalLabel,
  type BoardEvent,
} from "@/lib/monitor-ui";

interface IncidentDetailProps {
  event: BoardEvent;
  onClose: () => void;
}

function statusText(e: BoardEvent): string {
  switch (e.status) {
    case "accepted":
      return e.acceptedBy ? `Accepted by ${e.acceptedBy}` : "Accepted";
    case NEEDS_REVIEW_STATUS:
      return "Needs review — not auto-dispatched";
    case "resolved":
      return "Resolved";
    case "active":
      return "Active";
    default:
      return e.status || "—";
  }
}

/**
 * Saturday "selected incident" block: address, verify warnings, transcript,
 * key/value details and the status actions that used to sit inline on each
 * EventLog card (same PATCH /api/events/:id/status calls).
 */
export default function IncidentDetail({ event: e, onClose }: IncidentDetailProps) {
  const { accept, resolve, promote, pendingId } = useEventActions();
  const busy = pendingId === e.id;
  const isReview = e.status === NEEDS_REVIEW_STATUS;
  const { keywords: keywordList } = useKeywords();
  // Stored labels for this call plus whatever the current keyword list finds
  // (same detection the live feed uses), all escaped by highlightKeywords.
  const html = highlightKeywords(e.transcript || "", [
    ...eventKeywordLabels(e),
    ...detectKeywords(e.transcript || "", keywordList).map((k) => k.keyword),
  ]);

  return (
    <div data-testid={`incident-detail-${e.id}`}>
      <h2>{formatAddress(e)}</h2>
      <div className="sat-sub">
        {signalLabel(e.signalType)} · {e.district} · {ago(e.createdAt)} ago
      </div>

      {isReview && (
        <div className="sat-blk verify">
          <h3>Needs review</h3>
          Unresolved address — not auto-dispatched or sent to Telegram. Listen back before making it active.
        </div>
      )}
      {e.addressFromContext && (
        <div className="sat-blk verify">
          <h3>Verify</h3>
          Address recovered from surrounding audio, not this call. Confirm before dispatching.
        </div>
      )}
      {e.locationApprox && (
        <div className="sat-blk verify">
          <h3>Approximate location</h3>
          Single cross street named — may need to search the exact location. Read the transcript for context.
        </div>
      )}

      <div className="sat-blk">
        <h3>Transcript</h3>
        {e.transcript ? (
          <div className="sat-transcript" dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <div className="sat-transcript" style={{ color: "var(--sat-muted)" }}>No transcript</div>
        )}
      </div>

      <div className="sat-blk">
        <h3>Details</h3>
        <dl className="sat-kv">
          <dt>Signal</dt>
          <dd>{e.signalType || "—"}</dd>
          <dt>Cross street</dt>
          <dd>{e.crossStreet || "—"}</dd>
          {e.geocodedRoad && (
            <>
              <dt>Road x-ref</dt>
              <dd>{e.geocodedRoad}</dd>
            </>
          )}
          <dt>Coordinates</dt>
          <dd className="sat-mono">
            {Number.isFinite(e.lat) && Number.isFinite(e.lng)
              ? `${(e.lat as number).toFixed(4)}, ${(e.lng as number).toFixed(4)}`
              : "— (no map pin)"}
          </dd>
          <dt>Source</dt>
          <dd>{e.source || "—"}</dd>
          <dt>Received</dt>
          <dd className="sat-mono">{new Date(e.createdAt).toLocaleString("en-US", { hour12: false })}</dd>
          <dt>Status</dt>
          <dd>{statusText(e)}</dd>
          {e.description && (
            <>
              <dt>Note</dt>
              <dd>{e.description}</dd>
            </>
          )}
        </dl>
      </div>

      <div className="sat-actions">
        <button type="button" className="sat-btn" onClick={onClose} data-testid="detail-close">
          Close
        </button>
        {isReview && (
          <>
            <button type="button" className="sat-btn" disabled={busy} onClick={() => resolve(e.id)} data-testid={`dismiss-event-${e.id}`}>
              Dismiss
            </button>
            <button type="button" className="sat-btn primary" disabled={busy} onClick={() => promote(e.id)} data-testid={`promote-event-${e.id}`}>
              Make active
            </button>
          </>
        )}
        {e.status === "active" && (
          <>
            <button type="button" className="sat-btn" disabled={busy} onClick={() => resolve(e.id)} data-testid={`resolve-event-${e.id}`}>
              Resolve
            </button>
            <button type="button" className="sat-btn primary" disabled={busy} onClick={() => accept(e.id)} data-testid={`detail-accept-${e.id}`}>
              Accept
            </button>
          </>
        )}
        {e.status === "accepted" && (
          <button type="button" className="sat-btn" disabled={busy} onClick={() => resolve(e.id)} data-testid={`resolve-accepted-event-${e.id}`}>
            Resolve
          </button>
        )}
      </div>
    </div>
  );
}
