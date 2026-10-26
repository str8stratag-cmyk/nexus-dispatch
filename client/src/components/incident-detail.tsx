import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { X, ShieldAlert, CheckCircle2, MapPin } from "lucide-react";

export interface IncidentDetailEvent {
  id: number;
  transcript: string;
  address: string | null;
  crossStreet: string | null;
  geocodedRoad: string | null;
  signalType: string | null;
  description: string | null;
  district: string;
  source: string;
  status: string;
  acceptedBy?: string | null;
  addressFromContext?: boolean;
  locationApprox?: boolean;
  lat: number | null;
  lng: number | null;
  createdAt: string;
}

interface IncidentDetailProps {
  event: IncidentDetailEvent | null;
  onClose: () => void;
}

function ago(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

// Selected-incident panel (Saturday UI parity). Reuses the same
// PATCH /api/events/:id/status endpoint EventLog already uses for
// accept/resolve — no new server routes. There is no server endpoint to move
// an *active* event into the quarantinedDispatches collection (that only
// holds address-gate rejects), so the secondary action here is labeled
// "Resolve" rather than a misleading "Quarantine" that would not do what it
// implies.
export default function IncidentDetail({ event, onClose }: IncidentDetailProps) {
  const queryClient = useQueryClient();

  const acceptMutation = useMutation({
    mutationFn: async (id: number) => apiRequest("PATCH", `/api/events/${id}/status`, { status: "accepted" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/events"] }),
  });
  const resolveMutation = useMutation({
    mutationFn: async (id: number) => apiRequest("PATCH", `/api/events/${id}/status`, { status: "resolved" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/events"] });
      onClose();
    },
  });

  if (!event) {
    return (
      <div
        className="flex h-full items-center justify-center p-6 text-center text-xs text-muted-foreground"
        data-testid="incident-detail-empty"
      >
        Select a call to see details
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto p-3" data-testid="incident-detail">
      <div className="mb-1 flex items-start justify-between gap-2">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold leading-snug">
          <MapPin className="h-3.5 w-3.5 shrink-0 text-primary" />
          {event.crossStreet ? `${event.address || "Address unknown"} & ${event.crossStreet}` : event.address || "Address unknown"}
        </h2>
        <Button
          size="icon"
          variant="ghost"
          className="h-6 w-6 shrink-0"
          onClick={onClose}
          data-testid="incident-detail-close"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="mb-3 font-mono text-[11px] text-muted-foreground">
        {event.signalType || "Incident"} · {event.district} · {ago(event.createdAt)} ago
      </div>

      {event.addressFromContext && (
        <div className="mb-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-[11px] font-semibold text-amber-500">
          Address recovered from surrounding audio, not this call — verify before dispatching.
        </div>
      )}
      {event.locationApprox && (
        <div className="mb-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-[11px] font-semibold uppercase tracking-wide text-amber-500">
          Approximate location — single cross street named, may need to search exact location.
        </div>
      )}

      <div className="mb-2 rounded-md border border-border bg-muted/30 p-2.5">
        <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Transcript</div>
        <div className="font-mono text-xs leading-relaxed">{event.transcript || "—"}</div>
      </div>

      {event.geocodedRoad && (
        <div className="mb-2 text-[11px] text-amber-500">🛣️ Road x-ref: {event.geocodedRoad}</div>
      )}
      {event.description && <div className="mb-2 text-xs text-muted-foreground">{event.description}</div>}

      <div className="mb-2 rounded-md border border-border bg-muted/30 p-2.5">
        <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Details</div>
        <dl className="grid grid-cols-[88px_1fr] gap-y-1 text-xs">
          <dt className="text-muted-foreground">Signal</dt>
          <dd>{event.signalType || "—"}</dd>
          <dt className="text-muted-foreground">Cross street</dt>
          <dd>{event.crossStreet || "—"}</dd>
          <dt className="text-muted-foreground">Coordinates</dt>
          <dd>{event.lat != null && event.lng != null ? `${event.lat.toFixed(4)}, ${event.lng.toFixed(4)}` : "—"}</dd>
          <dt className="text-muted-foreground">Source</dt>
          <dd>{event.source}</dd>
          <dt className="text-muted-foreground">Status</dt>
          <dd>{event.status === "accepted" ? `Accepted${event.acceptedBy ? ` by ${event.acceptedBy}` : ""}` : event.status}</dd>
        </dl>
      </div>

      <div className="mt-auto flex gap-2 pt-2">
        <Button
          variant="outline"
          className="flex-1 text-xs"
          onClick={() => resolveMutation.mutate(event.id)}
          disabled={resolveMutation.isPending}
          data-testid="incident-detail-resolve"
        >
          <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" /> Resolve
        </Button>
        <Button
          className="flex-1 text-xs"
          onClick={() => acceptMutation.mutate(event.id)}
          disabled={event.status === "accepted" || acceptMutation.isPending}
          data-testid="incident-detail-accept"
        >
          <ShieldAlert className="mr-1.5 h-3.5 w-3.5" /> Accept
        </Button>
      </div>
    </div>
  );
}
