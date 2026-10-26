import { useState, useCallback, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useTheme } from "@/hooks/use-theme";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Sun, Moon, Radio, Send, Settings, ExternalLink, ShieldAlert } from "lucide-react";
import AudioPanel, { type DetectedEvent } from "@/components/audio-panel";
import EventLog from "@/components/event-log";
import DispatchMap from "@/components/dispatch-map";
import TranscriptFeed, { type TranscriptEntry } from "@/components/transcript-feed";
import ManualDispatch from "@/components/manual-dispatch";
import SettingsPanel from "@/components/settings-panel";
import QuarantinePanel from "@/components/quarantine-panel";
import NavRail from "@/components/nav-rail";
import StatusChips from "@/components/status-chips";
import IncidentDetail from "@/components/incident-detail";
import { useEventsStream } from "@/hooks/use-events-stream";

// Mono HH:MM:SS clock — Saturday UI parity top-bar chrome, purely cosmetic.
function HeaderClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(t);
  }, []);
  return (
    <span className="hidden font-mono text-xs font-semibold text-muted-foreground sm:inline" data-testid="header-clock">
      {now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
    </span>
  );
}

// Per-machine defaults from the server hostname: DISP-2 → District 2, source
// "DISP-2". A manually entered district/source (persisted in localStorage)
// always wins over these defaults.
function defaultsFromHostname(hostname: string | null | undefined): { district: string; source: string } {
  const match = hostname?.match(/disp(?:atch)?\s*-?\s*(\d+)/i);
  if (match) {
    return { district: `District ${match[1]}`, source: `DISP-${match[1]}` };
  }
  return { district: "District 1", source: hostname || "" };
}

export default function DispatchPage() {
  const { theme, toggleTheme } = useTheme();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [activeTab, setActiveTab] = useState("monitor");
  const [district, setDistrictState] = useState(() => localStorage.getItem("dispatch.district") || "District 1");
  const [sourceName, setSourceNameState] = useState(() => localStorage.getItem("dispatch.source") || "");
  const [districts, setDistricts] = useState<string[]>(["District 1", "District 2", "District 3", "District 4", "District 5", "District 6", "District 7"]);
  const [transcriptEntries, setTranscriptEntries] = useState<TranscriptEntry[]>([]);
  // Selected call — shared by the queue, map, and incident detail panel.
  const [selectedId, setSelectedId] = useState<number | null>(null);

  // Manual entries persist across restarts and always win over the
  // machine-derived defaults below.
  const setDistrict = useCallback((value: string) => {
    localStorage.setItem("dispatch.district", value);
    setDistrictState(value);
  }, []);
  const setSourceName = useCallback((value: string) => {
    localStorage.setItem("dispatch.source", value);
    setSourceNameState(value);
  }, []);

  const { data: machineConfig } = useQuery({
    queryKey: ["/api/machine"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/machine");
      return res.json() as Promise<{ hostname: string }>;
    },
    staleTime: Infinity,
    retry: false,
  });

  // Fresh browsers (nothing manually entered) self-configure from the
  // machine identity: DISP-N → District N, source "DISP-N". On a canonical
  // DISP-N machine the source is always "DISP-N": a stale or typo'd
  // localStorage value ("disp 3", "DISP3") is normalized instead of winning
  // forever — one box fed MongoDB variant spellings for a week because a
  // typed localStorage value always beat the hostname default.
  useEffect(() => {
    if (!machineConfig?.hostname) return;
    const defaults = defaultsFromHostname(machineConfig.hostname);
    if (!localStorage.getItem("dispatch.district")) {
      setDistrictState(defaults.district);
    }
    if (/^DISP-\d+$/.test(defaults.source)) {
      const stored = localStorage.getItem("dispatch.source");
      if (stored !== defaults.source) {
        setSourceName(defaults.source);
      }
    } else if (!localStorage.getItem("dispatch.source")) {
      setSourceNameState(defaults.source);
    }
  }, [machineConfig]);

  const { data: districtSettings } = useQuery({
    queryKey: ["/api/settings"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/settings");
      return res.json();
    },
  });

  useEffect(() => {
    if (!Array.isArray(districtSettings)) return;
    const stored = districtSettings.find((s: any) => s.key === "districts");
    if (stored && stored.value) {
      try {
        const parsed = JSON.parse(stored.value);
        if (Array.isArray(parsed) && parsed.length > 0) setDistricts(parsed);
      } catch {}
    }
  }, [districtSettings]);

  useEventsStream();

  // Same query key + queryFn as EventLog — react-query dedupes to one
  // request. Used for map pins and the incident detail panel (selection by
  // id), both Hillsborough / Tampa area; DispatchMap already centers on Tampa.
  const { data: mapEvents = [] } = useQuery({
    queryKey: ["/api/events"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/events?limit=200");
      return res.json() as Promise<Array<{
        id: number;
        lat: number | null;
        lng: number | null;
        address: string | null;
        crossStreet: string | null;
        geocodedRoad: string | null;
        signalType: string | null;
        description: string | null;
        district: string;
        source: string;
        transcript: string;
        createdAt: string;
        status: string;
        acceptedBy?: string | null;
        addressFromContext?: boolean;
        locationApprox?: boolean;
      }>>;
    },
    refetchInterval: 120_000,
  });

  const mapMarkers = mapEvents.filter(
    (e) => Number.isFinite(e.lat) && Number.isFinite(e.lng)
  );
  const selectedEvent = mapEvents.find((e) => e.id === selectedId) ?? null;

  const dispatchMutation = useMutation({
    mutationFn: async (data: any) => {
      return apiRequest("POST", "/api/dispatch", data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/events"] });
    },
    onError: (err: any) => {
      toast({
        title: "Dispatch Failed",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const handleDispatchDetected = useCallback(async (event: DetectedEvent) => {
    dispatchMutation.mutate({
      transcript: event.transcript,
      keywords: JSON.stringify(event.keywords),
      address: event.address || null,
      crossStreet: event.crossStreet || null,
      lat: null,
      lng: null,
      signalType: event.keywords[0]?.signalType || null,
      description: event.keywords.map((k) => k.signalType).join(", "),
      district: event.district,
      source: event.source,
      status: "active",
      isManual: false,
      // Address hold / chunk-time plumbing (intake-only or hints; see shared/schema.ts).
      contextTranscripts: event.contextTranscripts,
      clientRequestId: event.clientRequestId,
      audioStartedAt: event.audioStartedAt,
      audioEndedAt: event.audioEndedAt,
    });
  }, [dispatchMutation]);

  return (
    <div className="h-screen flex bg-background text-foreground">
      {/* Left icon rail (Saturday UI parity) — persistent nav across all tabs,
          replaces the desktop centered TabsList below. */}
      <NavRail active={activeTab} onChange={setActiveTab} />

      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex flex-1 min-h-0 flex-col">
        {/* Top bar */}
        <header className="flex items-center gap-3 border-b border-border bg-card/80 px-4 py-2.5 shrink-0">
          <Radio className="h-5 w-5 text-primary animate-pulse-live lg:hidden" />
          <div>
            <h1 className="text-[15px] font-bold tracking-tight">DISPATCH MONITOR</h1>
            <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground hidden sm:inline">
              Hillsborough County, FL · Traffic incident detection
            </span>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <StatusChips />
            <HeaderClock />
            {typeof window !== "undefined" && window.self !== window.top && (
              <Button
                onClick={() => window.open(window.location.href, "_blank")}
                variant="outline"
                size="sm"
                className="text-xs h-8"
                data-testid="header-open-tab"
              >
                <ExternalLink className="h-3 w-3 mr-1" />
                Open in New Tab
              </Button>
            )}
            <Button
              onClick={toggleTheme}
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              data-testid="theme-toggle"
            >
              {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </Button>
          </div>
        </header>

        {/* Mobile nav (rail is lg+ only) */}
        <TabsList className="mx-auto mt-2 grid w-full max-w-md grid-cols-4 lg:hidden">
          <TabsTrigger value="monitor" className="text-xs" data-testid="tab-monitor">
            <Radio className="h-3 w-3 mr-1" /> Live
          </TabsTrigger>
          <TabsTrigger value="manual" className="text-xs" data-testid="tab-manual">
            <Send className="h-3 w-3 mr-1" /> Manual
          </TabsTrigger>
          <TabsTrigger value="quarantine" className="text-xs" data-testid="tab-quarantine">
            <ShieldAlert className="h-3 w-3 mr-1" /> Review
          </TabsTrigger>
          <TabsTrigger value="settings" className="text-xs" data-testid="tab-settings">
            <Settings className="h-3 w-3 mr-1" /> Setup
          </TabsTrigger>
        </TabsList>

        {/* Live Monitor Tab — Saturday UI parity: queue (fixed) | map (hero,
            fills remaining width) | detail (fixed), with capture chrome
            relocated to a bottom strip. Hillsborough County / Tampa. */}
        {/* data-[state=inactive]:hidden: Radix leaves the inactive panel in the
            DOM with the `hidden` attribute, but `flex` overrides that, so this
            panel kept taking a flex-1 share and pushed Manual / Review /
            Setup halfway down the screen (2026-10-26). */}
        <TabsContent value="monitor" className="flex-1 min-h-0 mt-2 lg:mt-0 flex flex-col data-[state=inactive]:hidden">
          <div className="min-h-0 flex-1 grid grid-cols-1 gap-3 overflow-y-auto p-3 lg:grid-cols-[360px_minmax(0,1fr)_340px] lg:gap-px lg:overflow-hidden lg:bg-border lg:p-0">
            {/* Left: call queue (API newest-first) */}
            <section className="min-h-[360px] overflow-hidden rounded-lg border border-border bg-card shadow-sm lg:min-h-0 lg:rounded-none lg:border-0 lg:shadow-none">
              <EventLog selectedId={selectedId} onSelect={setSelectedId} />
            </section>

            {/* Center: Hillsborough County / Tampa map — hero, fills the
                remaining width (minmax(0,1fr)). flex + relative host so
                Leaflet gets a real non-zero height after the grid lays out. */}
            <section className="relative flex min-h-[280px] flex-col overflow-hidden rounded-lg border border-border bg-card shadow-sm lg:min-h-0 lg:h-full lg:rounded-none lg:border-0 lg:shadow-none" aria-label="Hillsborough County dispatch map">
              <DispatchMap markers={mapMarkers} selectedId={selectedId} onSelectMarker={setSelectedId} />
            </section>

            {/* Right: live transcripts (top) + selected incident (bottom) */}
            <section className="min-h-[360px] flex flex-col overflow-hidden rounded-lg border border-border bg-card shadow-sm lg:min-h-0 lg:rounded-none lg:border-0 lg:shadow-none">
              <div className={selectedId != null ? "min-h-0 flex-1 basis-1/2" : "min-h-0 flex-1"}>
                <TranscriptFeed entries={transcriptEntries} />
              </div>
              {selectedId != null && (
                <div className="min-h-0 flex-1 basis-1/2 border-t border-border">
                  <IncidentDetail event={selectedEvent} onClose={() => setSelectedId(null)} />
                </div>
              )}
            </section>
          </div>

          {/* Bottom strip: capture chrome (Saturday UI parity). Same
              AudioPanel instance/props as before — only its position moved,
              so useAudioCapture / heartbeat / lease / supervisor mount
              lifecycle is unchanged (still tied to this TabsContent only). */}
          <div className="shrink-0 border-t border-border bg-card px-3 py-1.5">
            <AudioPanel
              district={district}
              sourceName={sourceName}
              onDistrictChange={setDistrict}
              onSourceChange={setSourceName}
              districts={districts}
              onDispatchDetected={handleDispatchDetected}
              showTranscriptFeed={false}
              onTranscriptEntriesChange={setTranscriptEntries}
            />
          </div>
        </TabsContent>

        {/* Manual Dispatch Tab */}
        <TabsContent value="manual" className="flex-1 min-h-0 overflow-y-auto mt-2">
          <ManualDispatch districts={districts} sourceName={sourceName} />
        </TabsContent>

        {/* Settings Tab */}
        <TabsContent value="settings" className="flex-1 min-h-0 overflow-y-auto mt-2">
          <SettingsPanel />
        </TabsContent>

        {/* Quarantine Tab */}
        <TabsContent value="quarantine" className="flex-1 min-h-0 overflow-y-auto mt-2">
          <QuarantinePanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}
