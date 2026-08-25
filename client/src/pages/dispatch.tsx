import { useState, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useTheme } from "@/hooks/use-theme";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Sun, Moon, Radio, Send, Settings, ExternalLink } from "lucide-react";
import AudioPanel, { type DetectedEvent } from "@/components/audio-panel";
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

  return (
    <div className="h-screen flex flex-col bg-background text-foreground">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-border px-4 py-2 shrink-0">
        <div className="flex items-center gap-2">
          <Radio className="h-5 w-5 text-primary animate-pulse-live" />
          <h1 className="text-base font-bold tracking-tight">DISPATCH MONITOR</h1>
          <span className="text-xs text-muted-foreground hidden sm:inline">Traffic Accident Detection System</span>
        </div>
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

      {/* Tabs */}
      <Tabs defaultValue="monitor" className="flex-1 flex flex-col min-h-0">
        <TabsList className="grid w-full grid-cols-3 max-w-md mx-auto mt-2">
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
        <TabsContent value="monitor" className="flex-1 min-h-0 mt-2">
          <div className="h-full grid grid-cols-1 lg:grid-cols-[360px_minmax(0,1fr)] gap-2 p-2 overflow-y-auto lg:overflow-hidden">
            {/* Left: Audio Panel */}
            <div className="min-h-0 flex flex-col rounded-md border border-border bg-card overflow-hidden max-h-[500px] lg:max-h-none">
              <AudioPanel
                district={district}
                sourceName={sourceName}
                onDistrictChange={setDistrict}
                onSourceChange={setSourceName}
                districts={districts}
                onDispatchDetected={handleDispatchDetected}
              />
            </div>

            <section className="min-h-[360px] lg:min-h-0 flex flex-col gap-2">
              <div className="flex items-center justify-between rounded-md border border-border bg-card px-3 py-2">
                <div>
                  <h2 className="text-sm font-semibold">Live incident queue</h2>
                  <p className="text-xs text-muted-foreground">
                    Address text is retained as received. Automated map placement is paused.
                  </p>
                </div>
                <span className="rounded-full border border-primary/30 bg-primary/10 px-2 py-1 text-[10px] font-medium text-primary">
                  Location review
                </span>
              </div>
              <EventLog />
            </section>
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
