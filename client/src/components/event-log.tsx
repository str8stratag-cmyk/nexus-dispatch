import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CheckCircle2, Radio, MapPin, Clock, Download, ShieldAlert } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useEventsStream } from "@/hooks/use-events-stream";

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
  createdAt: string;
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
    "Manual Dispatch",
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
      e.isManual ? "Yes" : "No",
      parsedKeywords.map((k: any) => k.signalType).join("; "),
      e.description || "",
      (e.transcript || "").replace(/"/g, '""'),
    ];
  });

  const csv = [headers, ...rows]
    .map((row) => row.map((cell) => `"${cell}"`).join(","))
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

export default function EventLog() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: events = [], isLoading } = useQuery({
    queryKey: ["/api/events"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/events");
      return res.json() as Promise<DispatchEventRow[]>;
    },
    refetchInterval: 30_000,
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

  const activeEvents = events.filter((e) => e.status === "active");
  const acceptedEvents = events.filter((e) => e.status === "accepted");
  const resolvedEvents = events.filter((e) => e.status === "resolved");

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

  return (
    <Card className="h-full flex flex-col" data-testid="event-log">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between text-sm">
          <span className="flex items-center gap-2">
            <Radio className="h-4 w-4 text-primary" />
            Dispatch Events
          </span>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5">
              <Badge variant="outline" className="text-xs text-emerald-600 border-emerald-600/30 bg-emerald-600/10">
                {activeEvents.length} active
              </Badge>
              {acceptedEvents.length > 0 && (
                <Badge variant="outline" className="text-xs text-red-600 border-red-600/30 bg-red-600/10">
                  {acceptedEvents.length} accepted
                </Badge>
              )}
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 w-7 p-0"
                  data-testid="export-button"
                >
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
        </CardTitle>
      </CardHeader>
      <CardContent className="flex-1 overflow-y-auto space-y-2 p-2">
        {isLoading && (
          <div className="text-xs text-muted-foreground text-center p-4">Loading events...</div>
        )}
        {!isLoading && events.length === 0 && (
          <div className="text-xs text-muted-foreground text-center p-4 italic">
            No dispatch events yet
          </div>
        )}
        {activeEvents.map((event) => (
          <div
            key={event.id}
            className="group rounded-r-lg border border-l-[3px] border-emerald-900/30 border-l-emerald-500 bg-emerald-950/10 p-3 space-y-2 transition-all hover:translate-x-1 hover:bg-emerald-950/20 hover:shadow-md"
            data-testid={`event-${event.id}`}
          >
            <div className="flex items-center justify-between">
              <Badge variant="default" className="text-[10px] bg-emerald-600/90 hover:bg-emerald-600">
                {event.signalType || "Unknown"}
              </Badge>
              <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                <Clock className="h-2.5 w-2.5" />
                {new Date(event.createdAt).toLocaleTimeString("en-US", {
                  hour: "2-digit",
                  minute: "2-digit",
                  hour12: false,
                })}
              </div>
            </div>
            {event.address && (
              <div className="flex items-center gap-1 text-xs font-mono text-foreground">
                <MapPin className="h-3 w-3 text-primary shrink-0" />
                {event.crossStreet ? `${event.address} & ${event.crossStreet}` : event.address}
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
                {event.isManual && (event.source === "Manual Dispatch" ? " • Manual" : " • TERMINAL")}
              </span>
              <div className="flex items-center gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-[10px] text-emerald-600 hover:text-emerald-500 hover:bg-emerald-950/20"
                  onClick={() => acceptMutation.mutate(event.id)}
                  data-testid={`accept-event-${event.id}`}
                >
                  <ShieldAlert className="h-3 w-3 mr-1" /> Accept
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-[10px]"
                  onClick={() => resolveMutation.mutate(event.id)}
                  data-testid={`resolve-event-${event.id}`}
                >
                  <CheckCircle2 className="h-3 w-3 mr-1" /> Resolve
                </Button>
              </div>
            </div>
          </div>
        ))}
        {acceptedEvents.map((event) => (
          <div
            key={event.id}
            className="rounded-r-lg border border-l-[3px] border-red-900/40 border-l-red-500 bg-red-950/10 p-3 space-y-2 opacity-90"
            data-testid={`accepted-event-${event.id}`}
          >
            <div className="flex items-center justify-between">
              <Badge variant="default" className="text-[10px] bg-red-600/90 hover:bg-red-600">
                {event.signalType || "Unknown"}
              </Badge>
              <div className="flex items-center gap-1 text-[10px] text-red-400 font-semibold uppercase tracking-wider">
                <ShieldAlert className="h-3 w-3" />
                Accepted
              </div>
            </div>
            {event.address && (
              <div className="flex items-center gap-1 text-xs font-mono text-foreground">
                <MapPin className="h-3 w-3 text-red-400 shrink-0" />
                {event.crossStreet ? `${event.address} & ${event.crossStreet}` : event.address}
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
                onClick={() => resolveMutation.mutate(event.id)}
                data-testid={`resolve-accepted-event-${event.id}`}
              >
                <CheckCircle2 className="h-3 w-3 mr-1" /> Resolve
              </Button>
            </div>
          </div>
        ))}
        {resolvedEvents.slice(0, 10).map((event) => (
          <div
            key={event.id}
            className="rounded-r-lg border border-l-[3px] border-border/40 border-l-muted-foreground/50 bg-muted/20 p-3 space-y-1 opacity-60"
          >
            <div className="flex items-center justify-between">
              <Badge variant="outline" className="text-[10px]">
                {event.signalType || "Unknown"}
              </Badge>
              <span className="text-[10px] text-muted-foreground">
                Resolved • {new Date(event.createdAt).toLocaleTimeString("en-US", {
                  hour: "2-digit",
                  minute: "2-digit",
                  hour12: false,
                })}
              </span>
            </div>
            {event.address && (
              <div className="flex items-center gap-1 text-xs font-mono text-muted-foreground">
                <MapPin className="h-3 w-3 shrink-0" />
                {event.address}
              </div>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
