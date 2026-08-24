import { useState, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useTheme } from "@/hooks/use-theme";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Sun, Moon, Radio, Send, Settings, ExternalLink, MapPinned } from "lucide-react";
import AudioPanel, { type DetectedEvent } from "@/components/audio-panel";
import DispatchMap from "@/components/dispatch-map";
import EventLog from "@/components/event-log";
import ManualDispatch from "@/components/manual-dispatch";
import SettingsPanel from "@/components/settings-panel";

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
  createdAt: string;
}

export default function DispatchPage() {
  const { theme, toggleTheme } = useTheme();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [district, setDistrict] = useState("District 1");
  const [sourceName, setSourceName] = useState("");
  const [districts] = useState<string[]>(["District 1", "District 2", "District 3", "District 4", "District 5", "District 6", "District 7"]);

  const { data: events = [] } = useQuery<DispatchEventRow[]>({
    queryKey: ["/api/events"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/events");
      return res.json();
    },
    refetchInterval: 5000,
  });

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

  const geocodeMutation = useMutation({
    mutationFn: async (address: string) => {
      const res = await apiRequest("GET", `/api/geocode?q=${encodeURIComponent(address)}`);
      return res.json();
    },
  });

  const handleDispatchDetected = useCallback(async (event: DetectedEvent) => {
    let lat: number | null = null;
    let lng: number | null = null;

    // Build the best geocode query from address + crossStreet
    const geocodeQuery = event.crossStreet
      ? `${event.address} and ${event.crossStreet}`
      : event.address;

    if (geocodeQuery) {
      try {
        const geo = await geocodeMutation.mutateAsync(geocodeQuery);
        lat = geo.lat;
        lng = geo.lng;
      } catch (err) {
        console.error("Geocoding failed:", err);
      }
    }

    dispatchMutation.mutate({
      transcript: event.transcript,
      keywords: JSON.stringify(event.keywords),
      address: event.address || null,
      crossStreet: event.crossStreet || null,
      lat,
      lng,
      signalType: event.keywords[0]?.signalType || null,
      description: event.keywords.map((k) => k.signalType).join(", "),
      district: event.district,
      source: event.source,
      status: "active",
      isManual: false,
    });
  }, [dispatchMutation, geocodeMutation]);

  // Map markers from events
  const mapMarkers = events
    .filter((e) => e.lat && e.lng)
    .map((e) => ({
      id: e.id,
      lat: e.lat!,
      lng: e.lng!,
      address: e.address || "",
      crossStreet: e.crossStreet || "",
      signalType: e.signalType || "",
      description: e.description || "",
      district: e.district,
      transcript: e.transcript,
      createdAt: e.createdAt,
    }));

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
              Traffic Accident Detection System
            </span>
          </div>
          <span className="ml-2 hidden items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-emerald-500 sm:inline-flex">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse-live" />
            Live
          </span>
        </div>
        <TabsList className="absolute left-1/2 hidden h-auto w-auto -translate-x-1/2 grid-cols-3 gap-1 rounded-lg bg-muted/50 p-1 lg:grid">
          <TabsTrigger value="monitor" className="px-4 py-2 text-xs data-[state=active]:bg-primary data-[state=active]:text-primary-foreground" data-testid="tab-monitor">
            <Radio className="mr-1 h-3 w-3" /> Live Monitor
          </TabsTrigger>
          <TabsTrigger value="manual" className="px-4 py-2 text-xs" data-testid="tab-manual">
            <Send className="mr-1 h-3 w-3" /> Manual Dispatch
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

        <TabsList className="mx-auto mt-2 grid w-full max-w-md grid-cols-3 lg:hidden">
          <TabsTrigger value="monitor" className="text-xs" data-testid="tab-monitor">
            <Radio className="h-3 w-3 mr-1" /> Live Monitor
          </TabsTrigger>
          <TabsTrigger value="manual" className="text-xs" data-testid="tab-manual">
            <Send className="h-3 w-3 mr-1" /> Manual Dispatch
          </TabsTrigger>
          <TabsTrigger value="settings" className="text-xs" data-testid="tab-settings">
            <Settings className="h-3 w-3 mr-1" /> Settings
          </TabsTrigger>
        </TabsList>

        {/* Live Monitor Tab */}
        <TabsContent value="monitor" className="flex-1 min-h-0 mt-2 lg:mt-0">
          <div className="h-full grid grid-cols-1 gap-3 overflow-y-auto p-3 lg:grid-cols-[320px_minmax(0,1fr)_380px] lg:gap-px lg:overflow-hidden lg:bg-border lg:p-0">
            {/* Capture controls and a full-height transcript feed. */}
            <div className="min-h-[520px] flex flex-col rounded-lg border border-border bg-card p-3 shadow-sm lg:min-h-0 lg:rounded-none lg:border-0 lg:shadow-none">
              <AudioPanel
                district={district}
                sourceName={sourceName}
                onDistrictChange={setDistrict}
                onSourceChange={setSourceName}
                districts={districts}
                onDispatchDetected={handleDispatchDetected}
              />
            </div>

            {/* Center map uses the full-height reference layout. */}
            <section className="relative min-h-[260px] overflow-hidden rounded-lg border border-border bg-card shadow-sm lg:min-h-0 lg:rounded-none lg:border-0 lg:shadow-none" data-testid="map-container">
              <DispatchMap markers={mapMarkers} />
              <div className="pointer-events-none absolute left-3 top-3 rounded-md border border-border/80 bg-background/90 px-3 py-2 shadow-lg backdrop-blur">
                <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider">
                  <MapPinned className="h-3.5 w-3.5 text-primary" />
                  Active incidents
                </div>
                <div className="mt-1 text-[10px] font-mono text-muted-foreground">
                  {mapMarkers.length} mapped signal{mapMarkers.length === 1 ? "" : "s"}
                </div>
              </div>
            </section>

            {/* Current incidents remain in a dedicated right-hand queue. */}
            <div className="min-h-[360px] lg:min-h-0">
              <EventLog />
            </div>
          </div>
        </TabsContent>

        {/* Manual Dispatch Tab */}
        <TabsContent value="manual" className="flex-1 min-h-0 overflow-y-auto mt-2">
          <ManualDispatch districts={districts} />
        </TabsContent>

        {/* Settings Tab */}
        <TabsContent value="settings" className="flex-1 min-h-0 overflow-y-auto mt-2">
          <SettingsPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}
