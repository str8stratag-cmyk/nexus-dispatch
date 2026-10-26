import { useState, useCallback, useEffect, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useTheme } from "@/hooks/use-theme";
import { useToast } from "@/hooks/use-toast";
import AudioPanel, { type DetectedEvent, type CaptureUiState } from "@/components/audio-panel";
import EventLog from "@/components/event-log";
import DispatchMap from "@/components/dispatch-map";
import TranscriptFeed, { type TranscriptEntry } from "@/components/transcript-feed";
import IncidentDetail from "@/components/incident-detail";
import ManualDispatch from "@/components/manual-dispatch";
import SettingsPanel from "@/components/settings-panel";
import QuarantinePanel from "@/components/quarantine-panel";
import { Rail, TopBar, type HealthSnapshot, type MonitorView } from "@/components/monitor-chrome";
import { useEventsStream } from "@/hooks/use-events-stream";
import type { BoardEvent } from "@/lib/monitor-ui";

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

  // Single SSE subscription + /api/events query for the whole board (queue,
  // map and detail all read this; previously EventLog opened its own stream).
  useEventsStream();

  const { data: events = [], isLoading: eventsLoading } = useQuery({
    queryKey: ["/api/events"],
    queryFn: async () => {
      // Cap the poll payload — the server costs ~7ms per returned doc on
      // Atlas M0. SSE pushes live updates; this poll is a slow catch-up net.
      const res = await apiRequest("GET", "/api/events?limit=200");
      return res.json() as Promise<BoardEvent[]>;
    },
    refetchInterval: 120_000,
  });

  const mapMarkers = useMemo(
    () => events.filter((e) => Number.isFinite(e.lat) && Number.isFinite(e.lng)),
    [events],
  );

  // Read-only status for the header chips (existing endpoint, no new logic).
  const { data: health, isError: healthError } = useQuery({
    queryKey: ["/api/health"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/health");
      return res.json() as Promise<HealthSnapshot>;
    },
    refetchInterval: 30_000,
    retry: false,
  });

  // ---- Saturday board UI state -------------------------------------------
  const [view, setView] = useState<MonitorView>("monitor");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [focus, setFocus] = useState<{ id: number; n: number } | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [phonePane, setPhonePane] = useState<"queue" | "map">("queue");
  const [captureState, setCaptureState] = useState<CaptureUiState | null>(null);

  const selectedEvent = useMemo(
    () => (selectedId == null ? null : events.find((e) => e.id === selectedId) ?? null),
    [events, selectedId],
  );

  /** Select a call; `pan` moves the map to it (queue / transcript clicks). */
  const selectEvent = useCallback((id: number, pan: boolean) => {
    setSelectedId(id);
    setDrawerOpen(true);
    if (pan) setFocus((f) => ({ id, n: (f?.n ?? 0) + 1 }));
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedId(null);
    setDrawerOpen(false);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && view === "monitor") clearSelection();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [view, clearSelection]);

  // A transcript detection → the call it most likely produced: same signal
  // type, created within ~3 min after the transcript, nearest first.
  const handleHitClick = useCallback(
    (entry: TranscriptEntry, signals: string[]) => {
      const set = new Set(signals);
      const match = events
        .filter((e) => e.signalType && set.has(e.signalType))
        .map((e) => ({ e, dt: new Date(e.createdAt).getTime() - entry.timestamp }))
        .filter(({ dt }) => dt >= -30_000 && dt <= 180_000)
        .sort((a, b) => Math.abs(a.dt) - Math.abs(b.dt))[0];
      if (match) selectEvent(match.e.id, true);
    },
    [events, selectEvent],
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

  const isMonitor = view === "monitor";

  return (
    <div
      className={`sat-app ${isMonitor ? "" : "sat-other"} ${phonePane === "map" ? "show-map" : ""}`}
      data-testid="dispatch-board"
    >
      <Rail view={view} onView={setView} />

      <TopBar
        sourceName={sourceName}
        capture={captureState}
        health={health}
        healthError={healthError}
        theme={theme}
        onToggleTheme={toggleTheme}
        phonePane={isMonitor ? phonePane : undefined}
        onPhonePane={setPhonePane}
        onToggleDrawer={isMonitor ? () => setDrawerOpen((v) => !v) : undefined}
      />

      {isMonitor ? (
        <>
          {/* Left: call queue (newest first) */}
          <EventLog
            events={events}
            isLoading={eventsLoading}
            selectedId={selectedId}
            onSelect={(id) => selectEvent(id, true)}
          />

          {/* Center hero: Hillsborough County / Tampa map (Esri keyless tiles).
              .sat-mapwrap is position:relative with a real grid height, so the
              absolutely-positioned Leaflet host never collapses. */}
          <main className="sat-mapwrap" aria-label="Hillsborough County dispatch map">
            <DispatchMap
              markers={mapMarkers}
              selectedId={selectedId}
              onSelect={(id) => selectEvent(id, false)}
              focus={focus}
            />
          </main>

          {/* Right: live transcripts (top) + selected incident (bottom) */}
          <aside className={`sat-detail ${drawerOpen ? "open" : ""}`} aria-label="Transcripts and incident">
            <section className="sat-feed">
              <TranscriptFeed
                entries={transcriptEntries}
                sourceLabel={sourceName || district}
                showHeader
                onHitClick={handleHitClick}
              />
            </section>
            {selectedEvent && (
              <section className="sat-inc">
                <IncidentDetail event={selectedEvent} onClose={clearSelection} />
              </section>
            )}
          </aside>
        </>
      ) : (
        <section className="sat-view">
          {view === "manual" && <ManualDispatch districts={districts} sourceName={sourceName} />}
          {view === "quarantine" && <QuarantinePanel />}
          {view === "settings" && <SettingsPanel />}
        </section>
      )}

      {/* Bottom strip: capture controls + desk RMS + ticker. Rendered on every
          view so switching rail views never unmounts capture. */}
      <AudioPanel
        layout="strip"
        district={district}
        sourceName={sourceName}
        onDistrictChange={setDistrict}
        onSourceChange={setSourceName}
        districts={districts}
        onDispatchDetected={handleDispatchDetected}
        showTranscriptFeed={false}
        onTranscriptEntriesChange={setTranscriptEntries}
        onCaptureStateChange={setCaptureState}
      />
    </div>
  );
}
