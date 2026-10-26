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
import { useEventsStream } from "@/hooks/use-events-stream";

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

  const [district, setDistrictState] = useState(() => localStorage.getItem("dispatch.district") || "District 1");
  const [sourceName, setSourceNameState] = useState(() => localStorage.getItem("dispatch.source") || "");
  const [districts, setDistricts] = useState<string[]>(["District 1", "District 2", "District 3", "District 4", "District 5", "District 6", "District 7"]);
  const [transcriptEntries, setTranscriptEntries] = useState<TranscriptEntry[]>([]);

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

  // Same query key as EventLog — react-query dedupes. Used only for map pins
  // (Hillsborough / Tampa area; DispatchMap already centers on Tampa).
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
        transcript: string;
        createdAt: string;
        status?: string;
      }>>;
    },
    refetchInterval: 120_000,
  });

  const mapMarkers = mapEvents.filter(
    (e) => Number.isFinite(e.lat) && Number.isFinite(e.lng)
  );

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
    <div className="h-screen flex flex-col bg-background text-foreground">
      <Tabs defaultValue="monitor" className="flex-1 flex flex-col min-h-0">
      {/* Header */}
      <header className="relative flex items-center justify-between border-b border-border bg-card/80 px-4 py-2.5 shrink-0">
        <div className="flex items-center gap-2">
          <Radio className="h-5 w-5 text-primary animate-pulse-live" />
          <div>
            <h1 className="text-base font-bold tracking-tight">DISPATCH MONITOR</h1>
            <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground hidden sm:inline">
              Hillsborough · Tampa · Traffic Accident Detection
            </span>
          </div>
          <span className="ml-2 hidden items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-emerald-500 sm:inline-flex">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse-live" />
            Live
          </span>
        </div>
        <TabsList className="absolute left-1/2 hidden h-auto w-auto -translate-x-1/2 grid-cols-5 gap-1 rounded-lg bg-muted/50 p-1 lg:grid">
          <TabsTrigger value="monitor" className="px-4 py-2 text-xs data-[state=active]:bg-primary data-[state=active]:text-primary-foreground" data-testid="tab-monitor">
            <Radio className="mr-1 h-3 w-3" /> Live Monitor
          </TabsTrigger>
          <TabsTrigger value="manual" className="px-4 py-2 text-xs" data-testid="tab-manual">
            <Send className="mr-1 h-3 w-3" /> Manual Dispatch
          </TabsTrigger>
          <TabsTrigger value="quarantine" className="px-4 py-2 text-xs" data-testid="tab-quarantine">
            <ShieldAlert className="mr-1 h-3 w-3" /> Quarantine
          </TabsTrigger>
          <TabsTrigger value="settings" className="px-4 py-2 text-xs" data-testid="tab-settings">
            <Settings className="mr-1 h-3 w-3" /> Settings
          </TabsTrigger>
        </TabsList>
        <div className="flex items-center gap-2">
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
          {theme === "dark" ? (
            <Sun className="h-4 w-4" />
          ) : (
            <Moon className="h-4 w-4" />
          )}
          </Button>
        </div>
      </header>

        <TabsList className="mx-auto mt-2 grid w-full max-w-md grid-cols-5 lg:hidden">
          <TabsTrigger value="monitor" className="text-xs" data-testid="tab-monitor">
            <Radio className="h-3 w-3 mr-1" /> Live Monitor
          </TabsTrigger>
          <TabsTrigger value="manual" className="text-xs" data-testid="tab-manual">
            <Send className="h-3 w-3 mr-1" /> Manual
          </TabsTrigger>
          <TabsTrigger value="quarantine" className="text-xs" data-testid="tab-quarantine">
            <ShieldAlert className="h-3 w-3 mr-1" /> Quarantine
          </TabsTrigger>
          <TabsTrigger value="settings" className="text-xs" data-testid="tab-settings">
            <Settings className="h-3 w-3 mr-1" /> Settings
          </TabsTrigger>
        </TabsList>

        {/* Live Monitor Tab — 3-pane Hillsborough / Tampa board:
            top capture strip (Web Audio / heartbeat unchanged), then
            left calls (~320–360), smaller center map, wider right transcripts
            (newest-first). Map is Hillsborough County / Tampa. */}
        <TabsContent value="monitor" className="flex-1 min-h-0 mt-2 lg:mt-0 flex flex-col">
          <div className="shrink-0 border-b border-border bg-card px-2 py-1.5">
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
          <div className="min-h-0 flex-1 grid grid-cols-1 gap-3 overflow-y-auto p-3 lg:grid-cols-[minmax(300px,360px)_minmax(220px,0.9fr)_minmax(380px,1.2fr)] lg:gap-px lg:overflow-hidden lg:bg-border lg:p-0">
            {/* Left: calls / dispatch events (API newest-first) */}
            <section className="min-h-[360px] overflow-hidden rounded-lg border border-border bg-card p-3 shadow-sm lg:min-h-0 lg:rounded-none lg:border-0 lg:shadow-none">
              <EventLog />
            </section>

            {/* Center: Hillsborough County / Tampa map (smaller fr).
                flex + relative host so Leaflet gets a real non-zero height after
                the 3-pane grid lays out (calc(100%-2rem) alone collapsed on lg). */}
            <section className="flex min-h-[280px] flex-col overflow-hidden rounded-lg border border-border bg-card shadow-sm lg:min-h-0 lg:h-full lg:rounded-none lg:border-0 lg:shadow-none" aria-label="Hillsborough County dispatch map">
              <div className="flex h-7 shrink-0 items-center border-b border-border bg-muted/30 px-3">
                <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                  Hillsborough · Tampa map
                </span>
              </div>
              <div className="relative min-h-[240px] flex-1 lg:min-h-0">
                <DispatchMap markers={mapMarkers} />
              </div>
            </section>

            {/* Right: live transcripts · newest first (wider) */}
            <section className="min-h-[360px] flex flex-col overflow-hidden rounded-lg border border-border bg-card shadow-sm lg:min-h-0 lg:rounded-none lg:border-0 lg:shadow-none">
              <div className="flex h-8 shrink-0 items-center border-b border-border bg-muted/30 px-3">
                <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                  Live transcripts · newest first
                </span>
              </div>
              <div className="min-h-0 flex-1">
                <TranscriptFeed entries={transcriptEntries} />
              </div>
            </section>
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
