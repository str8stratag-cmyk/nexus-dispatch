import { useEffect, useMemo, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Download } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useEventActions } from "@/hooks/use-event-actions";
import { NEEDS_REVIEW_STATUS } from "@shared/review-event";
import { ago, formatAddress, severityOf, type BoardEvent, type Severity } from "@/lib/monitor-ui";

// Saturday call queue (left column): stats, filter pills, search, compact
// severity-bordered cards. Selecting a card drives the map + incident detail.
// Status changes go through useEventActions (same PATCH as before).

type DispatchEventRow = BoardEvent & { keywords: string; source: string; status: string; isManual: boolean; locationApprox: boolean };

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

type QueueFilter = "all" | Severity | "open";

const FILTERS: Array<[QueueFilter, string]> = [
  ["all", "All"],
  ["crit", "Injury"],
  ["warn", "Crash"],
  ["info", "Tow / other"],
  ["open", "Unaccepted"],
];

const RESOLVED_SHOWN = 10;

interface EventLogProps {
  events: BoardEvent[];
  isLoading?: boolean;
  selectedId: number | null;
  onSelect: (id: number) => void;
}

function matchesQuery(e: BoardEvent, q: string): boolean {
  if (!q) return true;
  return [e.address, e.crossStreet, e.geocodedRoad, e.transcript, e.district, e.source, e.signalType, e.description]
    .join(" ")
    .toLowerCase()
    .includes(q);
}

export default function EventLog({ events, isLoading = false, selectedId, onSelect }: EventLogProps) {
  const { toast } = useToast();
  const { accept, pendingId } = useEventActions();
  const [filter, setFilter] = useState<QueueFilter>("all");
  const [query, setQuery] = useState("");
  // Re-render every 30 s so the relative "ago" stamps stay honest.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);

  const rows = events as DispatchEventRow[];

  const stats = useMemo(() => {
    const hourAgo = now - 60 * 60_000;
    return {
      active: rows.filter((e) => e.status === "active").length,
      review: rows.filter((e) => e.status === NEEDS_REVIEW_STATUS).length,
      lastHour: rows.filter((e) => new Date(e.createdAt).getTime() > hourAgo).length,
    };
  }, [rows, now]);

  const { open, resolved } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const byFilter = (e: DispatchEventRow) => {
      if (filter === "all") return true;
      if (filter === "open") return e.status === "active" || e.status === NEEDS_REVIEW_STATUS;
      return severityOf(e.signalType) === filter;
    };
    const newestFirst = (a: DispatchEventRow, b: DispatchEventRow) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    const visible = rows.filter((e) => byFilter(e) && matchesQuery(e, q));
    return {
      open: visible.filter((e) => e.status !== "resolved").sort(newestFirst),
      resolved: filter === "open" ? [] : visible.filter((e) => e.status === "resolved").sort(newestFirst).slice(0, RESOLVED_SHOWN),
    };
  }, [rows, filter, query]);

  const handleExportCSV = () => {
    if (rows.length === 0) {
      toast({ title: "No events to export", variant: "destructive" });
      return;
    }
    const csv = eventsToCSV(rows);
    const date = new Date().toISOString().split("T")[0];
    downloadFile(csv, `dispatch-history-${date}.csv`, "text/csv");
    toast({ title: "Export Complete", description: `${rows.length} events exported to CSV` });
  };

  const handleExportJSON = () => {
    if (rows.length === 0) {
      toast({ title: "No events to export", variant: "destructive" });
      return;
    }
    const json = eventsToJSON(rows);
    const date = new Date().toISOString().split("T")[0];
    downloadFile(json, `dispatch-history-${date}.json`, "application/json");
    toast({ title: "Export Complete", description: `${rows.length} events exported to JSON` });
  };

  const renderCard = (e: DispatchEventRow) => {
    const sev = severityOf(e.signalType);
    const isReview = e.status === NEEDS_REVIEW_STATUS;
    const cls = [
      "sat-card",
      `sev-${sev}`,
      e.status === "accepted" ? "accepted" : "",
      e.status === "resolved" ? "resolved" : "",
      isReview ? "review" : "",
      selectedId === e.id ? "sel" : "",
    ].join(" ");
    const reconciled = e.isManual && e.source !== "Manual Dispatch" && e.description?.startsWith("Reconciled from");
    return (
      <div
        key={e.id}
        role="button"
        tabIndex={0}
        aria-pressed={selectedId === e.id}
        className={cls}
        onClick={() => onSelect(e.id)}
        onKeyDown={(ev) => {
          if (ev.key === "Enter" || ev.key === " ") {
            ev.preventDefault();
            onSelect(e.id);
          }
        }}
        data-testid={
          isReview ? `review-event-${e.id}` : e.status === "accepted" ? `accepted-event-${e.id}` : `event-${e.id}`
        }
      >
        <div className="sat-r1">
          <span className="sat-sig">{e.signalType || "Unknown"}</span>
          <span className="sat-ago" title={new Date(e.createdAt).toLocaleString()}>
            {ago(e.createdAt, now)}
          </span>
        </div>
        <div className="sat-addr">{formatAddress(e)}</div>
        <div className="sat-meta">
          <span>{e.district}</span>
          <span>{e.source}</span>
          {e.isManual && e.source === "Manual Dispatch" && <span className="sat-tag">manual</span>}
          {reconciled && <span className="sat-tag">reconciled</span>}
          {isReview && <span className="sat-tag verify">needs review</span>}
          {e.addressFromContext && <span className="sat-tag verify">verify address</span>}
          {e.locationApprox && <span className="sat-tag verify">approx location</span>}
          {e.status === "accepted" && (
            <span className="sat-tag ok">✓ {e.acceptedBy || "accepted"}</span>
          )}
          {e.status === "resolved" && <span className="sat-tag">resolved</span>}
          {e.status === "active" && (
            <button
              type="button"
              className="sat-quick"
              disabled={pendingId === e.id}
              onClick={(ev) => {
                ev.stopPropagation();
                accept(e.id);
              }}
              onKeyDown={(ev) => ev.stopPropagation()}
              data-testid={`accept-event-${e.id}`}
              title="Accept this call"
            >
              ACCEPT
            </button>
          )}
        </div>
      </div>
    );
  };

  return (
    <aside className="sat-queue" data-testid="event-log" aria-label="Call queue">
      <div className="sat-qhead">
        <div className="sat-stats">
          <div className="sat-stat">
            <b>{stats.active}</b>
            <span>Active</span>
          </div>
          <div className={`sat-stat ${stats.review > 0 ? "warn" : ""}`} data-testid="review-count">
            <b>{stats.review}</b>
            <span>Review</span>
          </div>
          <div className="sat-stat">
            <b>{stats.lastHour}</b>
            <span>Last hr</span>
          </div>
        </div>
        <div className="sat-filters" role="group" aria-label="Filter calls">
          {FILTERS.map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={`sat-f ${filter === key ? "on" : ""}`}
              aria-pressed={filter === key}
              onClick={() => setFilter(key)}
              data-testid={`queue-filter-${key}`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="sat-searchrow">
          <input
            className="sat-search"
            type="search"
            value={query}
            onChange={(ev) => setQuery(ev.target.value)}
            placeholder="Search address, transcript, district…"
            aria-label="Search calls"
            data-testid="queue-search"
          />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" className="sat-iconbtn" style={{ height: 34, width: 34 }} title="Export history" data-testid="export-button">
                <Download />
              </button>
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
      </div>
      <div className="sat-list">
        {isLoading && <div className="sat-empty">Loading events…</div>}
        {!isLoading && rows.length === 0 && <div className="sat-empty">No dispatch events yet</div>}
        {!isLoading && rows.length > 0 && open.length === 0 && resolved.length === 0 && (
          <div className="sat-empty">No matching incidents</div>
        )}
        {open.map(renderCard)}
        {resolved.length > 0 && <div className="sat-divider">Recently resolved</div>}
        {resolved.map(renderCard)}
      </div>
    </aside>
  );
}
