import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CheckCircle2, Radio, MapPin, Clock, Download, ShieldAlert, Search } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { NEEDS_REVIEW_STATUS } from "@shared/review-event";
import { useEventsStream } from "@/hooks/use-events-stream";
import { signalSeverity, SEVERITY_BORDER, type Severity } from "@/lib/signal-severity";

interface DispatchEventRow {
  id: number;
  transcript: string;
  keywords: string;
  address: string | null;
  crossStreet: string | null;
  lat: number | null;
  lng: number | null;
  signalType: string | null;
  description: string | null;
  district: string;
  source: string;
  status: string;
  isManual: boolean;
  geocodedRoad: string | null;
  locationApprox: boolean;
  acceptedBy?: string | null;
  /** Address recovered from surrounding audio rather than the call's own transcript. */
  addressFromContext?: boolean;
  createdAt: string;
}

interface EventLogProps {
  /** Currently selected call (controlled by the parent board so map + detail stay in sync). */
  selectedId?: number | null;
  onSelect?: (id: number) => void;
  /** Accepted / resolved calls are hidden from the queue (and map) unless
   *  this is on. Owned by the page so the map follows the same switch. */
  showHandled?: boolean;
  onShowHandledChange?: (show: boolean) => void;
}

type QueueFilter = "all" | "crit" | "warn" | "info" | "open";

const FILTERS: { key: QueueFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "crit", label: "Injury" },
  { key: "warn", label: "Crash" },
  { key: "info", label: "Tow" },
  { key: "open", label: "Unaccepted" },
];

const ADDRESS_FROM_CONTEXT_NOTE = "Address from surrounding audio — verify.";

function neutralizeCsvCell(value: unknown): string {
  const v = String(value ?? "");
  // Prevent CSV/formula injection: a cell starting with =, +, -, or @ can be
  // interpreted as a formula by Excel/Sheets. Prefix with a quote to force text.
  if (/^[\t\r\n ]*[=+\-@]/.test(v)) {
    return `'${v}`;
  }
  return v;
}

function eventsToCSV(events: DispatchEventRow[]): string {
  const headers = [
    "Date",
    "Time",
    "Signal Type",
    "District",
    "Source",
    "Address",
    "Cross Street",
    "Road X-Ref",
    "Latitude",
    "Longitude",
    "Status",
    "Accepted By",
    "Manual Dispatch",
    "Address From Context",
    "Keywords",
    "Description",
    "Transcript",
  ];

  const rows = events.map((e) => {
    const date = new Date(e.createdAt);
    let parsedKeywords: any[] = [];
    try { parsedKeywords = JSON.parse(e.keywords || "[]"); } catch {}

    return [
      date.toLocaleDateString("en-US"),
      date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false }),
      e.signalType || "",
      e.district || "",
      e.source || "",
      e.address || "",
      e.crossStreet || "",
      e.geocodedRoad || "",
      e.lat ?? "",
      e.lng ?? "",
      e.status || "",
      e.acceptedBy || "",
      e.isManual ? "Yes" : "No",
      e.addressFromContext ? "Yes" : "No",
      parsedKeywords.map((k: any) => k.signalType).join("; "),
      e.description || "",
      (e.transcript || "").replace(/"/g, '""'),
    ];
  });

  const csv = [headers, ...rows]
    .map((row) => row.map((cell) => `"${neutralizeCsvCell(cell)}"`).join(","))
    .join("\n");

  return csv;
}

function eventsToJSON(events: DispatchEventRow[]): string {
  return JSON.stringify(events, null, 2);
}

function downloadFile(content: string, filename: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function ago(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function SeverityPill({ sev, label }: { sev: Severity; label: string }) {
  const toneClass =
    sev === "crit"
      ? "bg-red-500/15 text-red-500"
      : sev === "info"
      ? "bg-blue-500/15 text-blue-500"
      : "bg-amber-500/15 text-amber-500";
  return (
    <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wide ${toneClass}`}>
      {label}
    </span>
  );
}

export default function EventLog({ selectedId = null, onSelect, showHandled = false, onShowHandledChange }: EventLogProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [filter, setFilter] = useState<QueueFilter>("all");
  const [search, setSearch] = useState("");

  const { data: events = [], isLoading } = useQuery({
    queryKey: ["/api/events"],
    queryFn: async () => {
      // Cap the poll payload — the server costs ~7ms per returned doc on
      // Atlas M0, so the old unbounded fetch was 3.3s every 30s. SSE pushes
      // live updates; this poll is just a slow catch-up safety net.
      const res = await apiRequest("GET", "/api/events?limit=200");
      return res.json() as Promise<DispatchEventRow[]>;
    },
    refetchInterval: 120_000,
  });

  useEventsStream();

  const acceptMutation = useMutation({
    mutationFn: async (id: number) => {
      return apiRequest("PATCH", `/api/events/${id}/status`, { status: "accepted" });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/events"] });
    },
  });

  const resolveMutation = useMutation({
    mutationFn: async (id: number) => {
      return apiRequest("PATCH", `/api/events/${id}/status`, { status: "resolved" });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/events"] });
    },
  });

  const promoteMutation = useMutation({
    mutationFn: async (id: number) => {
      return apiRequest("PATCH", `/api/events/${id}/status`, { status: "active" });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/events"] });
    },
  });

  // Stats always reflect the full queue, independent of the filter/search below.
  const activeCount = events.filter((e) => e.status === "active").length;
  const reviewCount = events.filter((e) => e.status === NEEDS_REVIEW_STATUS).length;
  const lastHourCount = events.filter((e) => Date.now() - new Date(e.createdAt).getTime() < 60 * 60_000).length;

  const matchesFilter = (e: DispatchEventRow) => {
    if (filter === "all") return true;
    if (filter === "open") return e.status !== "accepted";
    return signalSeverity(e.signalType) === filter;
  };
  const matchesSearch = (e: DispatchEventRow) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return [e.address, e.crossStreet, e.district, e.transcript].filter(Boolean).join(" ").toLowerCase().includes(q);
  };
  const visible = events.filter((e) => matchesFilter(e) && matchesSearch(e));

  // Keyword calls the address gate rejected (shared/review-event.ts): shown so
  // a dispatcher can listen back, never auto-dispatched or sent to Telegram.
  const reviewEvents = visible.filter((e) => e.status === NEEDS_REVIEW_STATUS);
  const activeEvents = visible.filter((e) => e.status === "active");
  // Handled calls drop off the board by default so they don't clutter the
  // queue or the map (Zach, 2026-10-27); the "Show handled" pill brings them back.
  const acceptedEvents = showHandled ? visible.filter((e) => e.status === "accepted") : [];
  const resolvedEvents = showHandled ? visible.filter((e) => e.status === "resolved") : [];
  const handledCount = events.filter((e) => e.status === "accepted" || e.status === "resolved").length;
  const shownCount = reviewEvents.length + activeEvents.length + acceptedEvents.length + resolvedEvents.length;

  const handleExportCSV = () => {
    if (events.length === 0) {
      toast({ title: "No events to export", variant: "destructive" });
      return;
    }
    const csv = eventsToCSV(events);
    const date = new Date().toISOString().split("T")[0];
    downloadFile(csv, `dispatch-history-${date}.csv`, "text/csv");
    toast({ title: "Export Complete", description: `${events.length} events exported to CSV` });
  };

  const handleExportJSON = () => {
    if (events.length === 0) {
      toast({ title: "No events to export", variant: "destructive" });
      return;
    }
    const json = eventsToJSON(events);
    const date = new Date().toISOString().split("T")[0];
    downloadFile(json, `dispatch-history-${date}.json`, "application/json");
    toast({ title: "Export Complete", description: `${events.length} events exported to JSON` });
  };

  const selectableProps = (id: number) => ({
    onClick: () => onSelect?.(id),
    "aria-pressed": selectedId === id,
  });

  return (
    <div className="flex h-full flex-col" data-testid="event-log">
      {/* Queue head: stats + filter pills + search (Saturday UI parity) */}
      <div className="shrink-0 space-y-2 border-b border-border p-2.5">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-1.5 text-xs font-semibold">
            <Radio className="h-3.5 w-3.5 text-primary" />
            Dispatch Events
          </span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost" className="h-6 w-6 p-0" data-testid="export-button">
                <Download className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={handleExportCSV} data-testid="export-csv">
                <Download className="h-3 w-3 mr-2" />
                Export as CSV
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleExportJSON} data-testid="export-json">
                <Download className="h-3 w-3 mr-2" />
                Export as JSON
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <div className="grid grid-cols-3 gap-1.5">
          <div className="rounded-md bg-muted/40 px-2 py-1.5 text-center">
            <div className="font-mono text-base font-bold leading-none">{activeCount}</div>
            <div className="text-[9px] uppercase tracking-wide text-muted-foreground">Active</div>
          </div>
          <div className="rounded-md bg-muted/40 px-2 py-1.5 text-center">
            <div className="font-mono text-base font-bold leading-none">{reviewCount}</div>
            <div className="text-[9px] uppercase tracking-wide text-muted-foreground">Review</div>
          </div>
          <div className="rounded-md bg-muted/40 px-2 py-1.5 text-center">
            <div className="font-mono text-base font-bold leading-none">{lastHourCount}</div>
            <div className="text-[9px] uppercase tracking-wide text-muted-foreground">Last hr</div>
          </div>
        </div>
        <div className="flex flex-wrap gap-1" data-testid="queue-filters">
          {FILTERS.map(({ key, label }) => (
            <button
              key={key}
              type="button"
              onClick={() => setFilter(key)}
              className={`rounded-full border px-2 py-0.5 text-[11px] transition-colors ${
                filter === key
                  ? "border-primary bg-primary font-semibold text-primary-foreground"
                  : "border-border text-muted-foreground hover:text-foreground"
              }`}
              data-testid={`queue-filter-${key}`}
            >
              {label}
            </button>
          ))}
          {onShowHandledChange && (
            <button
              type="button"
              onClick={() => onShowHandledChange(!showHandled)}
              aria-pressed={showHandled}
              title="Accepted and resolved calls are hidden from the queue and map unless this is on"
              className={`ml-auto rounded-full border px-2 py-0.5 text-[11px] transition-colors ${
                showHandled
                  ? "border-primary text-primary"
                  : "border-dashed border-border text-muted-foreground hover:text-foreground"
              }`}
              data-testid="queue-show-handled"
            >
              {showHandled ? "Hide" : "Show"} handled ({handledCount})
            </button>
          )}
        </div>
        <div className="relative">
          <Search className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search address, transcript, district…"
            className="h-7 w-full rounded-md border border-input bg-background pl-6 pr-2 text-xs"
            data-testid="queue-search"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto space-y-2 p-2">
        {isLoading && (
          <div className="text-xs text-muted-foreground text-center p-4">Loading events...</div>
        )}
        {!isLoading && events.length === 0 && (
          <div className="text-xs text-muted-foreground text-center p-4 italic">
            No dispatch events yet
          </div>
        )}
        {!isLoading && events.length > 0 && shownCount === 0 && (visible.length > 0 ? (
          <div className="text-xs text-muted-foreground text-center p-4 italic">
            No open calls — accepted / resolved are hidden
          </div>
        ) : (

          <div className="text-xs text-muted-foreground text-center p-4 italic">
            No calls match the current filter/search
          </div>
        ))}
        {reviewEvents.map((event) => {
          const sev = signalSeverity(event.signalType);
          return (
            <div
              key={event.id}
              {...selectableProps(event.id)}
              className={`cursor-pointer rounded-r-lg border border-l-4 bg-amber-950/10 p-3 space-y-2 transition-all hover:bg-amber-950/20 ${SEVERITY_BORDER[sev]} ${selectedId === event.id ? "ring-2 ring-primary" : ""}`}
              data-testid={`review-event-${event.id}`}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <SeverityPill sev={sev} label={event.signalType || "Unknown"} />
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-amber-400">needs review</span>
                </div>
                <div className="flex items-center gap-1 text-[10px] font-mono text-muted-foreground">
                  <Clock className="h-2.5 w-2.5" />
                  {ago(event.createdAt)}
                </div>
              </div>
              <div className="text-[11px] font-semibold text-amber-400">
                ⚠️ Unresolved address — not auto-dispatched. {event.description}
              </div>
              {event.transcript && (
                <div className="line-clamp-3 border-l border-border/70 pl-2 text-[11px] leading-relaxed text-muted-foreground">
                  {event.transcript}
                </div>
              )}
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-mono text-muted-foreground">
                  {event.district} • {event.source}
                </span>
                <div className="flex items-center gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-[10px] text-amber-500"
                    onClick={(e) => { e.stopPropagation(); promoteMutation.mutate(event.id); }}
                    data-testid={`promote-event-${event.id}`}
                  >
                    <ShieldAlert className="h-3 w-3 mr-1" /> Make active
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-[10px]"
                    onClick={(e) => { e.stopPropagation(); resolveMutation.mutate(event.id); }}
                    data-testid={`dismiss-event-${event.id}`}
                  >
                    <CheckCircle2 className="h-3 w-3 mr-1" /> Dismiss
                  </Button>
                </div>
              </div>
            </div>
          );
        })}
        {activeEvents.map((event) => {
          const sev = signalSeverity(event.signalType);
          return (
            <div
              key={event.id}
              {...selectableProps(event.id)}
              className={`group cursor-pointer rounded-r-lg border border-l-4 bg-card p-3 space-y-2 transition-all hover:translate-x-1 hover:bg-muted/30 hover:shadow-md ${SEVERITY_BORDER[sev]} ${selectedId === event.id ? "ring-2 ring-primary" : ""}`}
              data-testid={`event-${event.id}`}
            >
              <div className="flex items-center justify-between">
                <SeverityPill sev={sev} label={event.signalType || "Unknown"} />
                <div className="flex items-center gap-1 text-[10px] font-mono text-muted-foreground">
                  <Clock className="h-2.5 w-2.5" />
                  {ago(event.createdAt)}
                </div>
              </div>
              {event.address && (
                <div className="flex items-center gap-1 text-xs font-mono font-semibold text-foreground">
                  <MapPin className="h-3 w-3 text-primary shrink-0" />
                  {event.crossStreet ? `${event.address} & ${event.crossStreet}` : event.address}
                </div>
              )}
              {event.addressFromContext && (
                <div className="rounded border border-amber-500/50 bg-amber-500/10 px-2 py-1 text-[11px] font-bold text-amber-400">
                  ⚠️ {ADDRESS_FROM_CONTEXT_NOTE}
                </div>
              )}
              {event.locationApprox && (
                <div className="rounded border border-amber-500/50 bg-amber-500/10 px-2 py-1 text-[11px] font-bold uppercase tracking-wide text-amber-400">
                  ⚠️ Approximate location — single cross street named, may need to search exact location. Read dispatch for context.
                </div>
              )}
              {event.geocodedRoad && (
                <div className="text-[11px] text-amber-500">
                  🛣️ Road x-ref: {event.geocodedRoad}
                </div>
              )}
              {event.description && (
                <div className="text-xs text-muted-foreground">{event.description}</div>
              )}
              {event.transcript && (
                <div className="line-clamp-2 border-l border-border/70 pl-2 text-[11px] leading-relaxed text-muted-foreground">
                  {event.transcript}
                </div>
              )}
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-mono text-muted-foreground">
                  {event.district} • {event.source}
                  {event.isManual && (event.source === "Manual Dispatch" ? " • Manual" : event.description?.startsWith("Reconciled from") ? " • Reconciled" : null)}
                </span>
                <div className="flex items-center gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-[10px] text-emerald-600 hover:text-emerald-500 hover:bg-emerald-950/20"
                    onClick={(e) => { e.stopPropagation(); acceptMutation.mutate(event.id); }}
                    data-testid={`accept-event-${event.id}`}
                  >
                    <ShieldAlert className="h-3 w-3 mr-1" /> Accept
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-[10px]"
                    onClick={(e) => { e.stopPropagation(); resolveMutation.mutate(event.id); }}
                    data-testid={`resolve-event-${event.id}`}
                  >
                    <CheckCircle2 className="h-3 w-3 mr-1" /> Resolve
                  </Button>
                </div>
              </div>
            </div>
          );
        })}
        {acceptedEvents.map((event) => {
          const sev = signalSeverity(event.signalType);
          return (
            <div
              key={event.id}
              {...selectableProps(event.id)}
              className={`cursor-pointer rounded-r-lg border border-l-4 bg-card p-3 space-y-2 opacity-60 transition-all hover:opacity-90 ${SEVERITY_BORDER[sev]} ${selectedId === event.id ? "ring-2 ring-primary" : ""}`}
              data-testid={`accepted-event-${event.id}`}
            >
              <div className="flex items-center justify-between">
                <SeverityPill sev={sev} label={event.signalType || "Unknown"} />
                <div className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-red-400">
                  <ShieldAlert className="h-3 w-3" />
                  Accepted
                  {event.acceptedBy ? (
                    <span className="normal-case tracking-normal font-medium text-red-300/80">
                      · {event.acceptedBy}
                    </span>
                  ) : null}
                </div>
              </div>
              {event.address && (
                <div className="flex items-center gap-1 text-xs font-mono text-foreground">
                  <MapPin className="h-3 w-3 text-red-400 shrink-0" />
                  {event.crossStreet ? `${event.address} & ${event.crossStreet}` : event.address}
                </div>
              )}
              {event.addressFromContext && (
                <div className="rounded border border-amber-500/50 bg-amber-500/10 px-2 py-1 text-[11px] font-bold text-amber-400">
                  ⚠️ {ADDRESS_FROM_CONTEXT_NOTE}
                </div>
              )}
              {event.locationApprox && (
                <div className="rounded border border-amber-500/50 bg-amber-500/10 px-2 py-1 text-[11px] font-bold uppercase tracking-wide text-amber-400">
                  ⚠️ Approximate location — single cross street named, may need to search exact location. Read dispatch for context.
                </div>
              )}
              {event.geocodedRoad && (
                <div className="text-[11px] text-amber-500">
                  🛣️ Road x-ref: {event.geocodedRoad}
                </div>
              )}
              {event.description && (
                <div className="text-xs text-muted-foreground">{event.description}</div>
              )}
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-mono text-muted-foreground">
                  {event.district} • {event.source}
                  {event.isManual && (event.source === "Manual Dispatch" ? " • Manual" : event.description?.startsWith("Reconciled from") ? " • Reconciled" : null)}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-[10px]"
                  onClick={(e) => { e.stopPropagation(); resolveMutation.mutate(event.id); }}
                  data-testid={`resolve-accepted-event-${event.id}`}
                >
                  <CheckCircle2 className="h-3 w-3 mr-1" /> Resolve
                </Button>
              </div>
            </div>
          );
        })}
        {resolvedEvents.slice(0, 10).map((event) => (
          <div
            key={event.id}
            {...selectableProps(event.id)}
            className={`cursor-pointer rounded-r-lg border border-l-4 border-l-muted-foreground/50 bg-muted/20 p-3 space-y-1 opacity-50 transition-all hover:opacity-80 ${selectedId === event.id ? "ring-2 ring-primary" : ""}`}
          >
            <div className="flex items-center justify-between">
              <span className="font-mono text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                {event.signalType || "Unknown"}
              </span>
              <span className="text-[10px] text-muted-foreground">
                Resolved • {ago(event.createdAt)}
              </span>
            </div>
            {event.address && (
              <div className="flex items-center gap-1 text-xs font-mono text-muted-foreground">
                <MapPin className="h-3 w-3 shrink-0" />
                {event.address}
              </div>
            )}
            {event.addressFromContext && (
              <div className="text-[10px] font-bold text-amber-500">
                ⚠️ {ADDRESS_FROM_CONTEXT_NOTE}
              </div>
            )}
            {event.locationApprox && (
              <div className="text-[10px] font-bold uppercase tracking-wide text-amber-500">
                ⚠️ Approximate location — single cross street named. Read dispatch for context.
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
