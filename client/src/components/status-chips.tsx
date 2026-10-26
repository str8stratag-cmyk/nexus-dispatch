import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";

// Read-only status chips for the top bar (Saturday UI parity). Polls the
// existing /api/health + /api/capture/status endpoints already used by the
// desk watchdog — no new server routes, no capture logic here.
interface HealthResponse {
  mongoConfigured: boolean;
  dispatch?: { quarantined?: number };
}
interface CaptureStatusResponse {
  effectiveCapturing: boolean;
  lastHeartbeatAgoMs: number | null;
}

function Dot({ tone }: { tone: "ok" | "warn" | "crit" }) {
  const color = tone === "crit" ? "bg-red-500" : tone === "warn" ? "bg-amber-500" : "bg-emerald-500";
  return <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${color} ${tone === "ok" ? "animate-pulse-live" : ""}`} />;
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-border px-2 py-1 font-mono text-[10px] font-semibold text-muted-foreground">
      {children}
    </span>
  );
}

export default function StatusChips() {
  const { data: health } = useQuery({
    queryKey: ["/api/health"],
    queryFn: async () => (await apiRequest("GET", "/api/health")).json() as Promise<HealthResponse>,
    refetchInterval: 15_000,
  });
  const { data: capture } = useQuery({
    queryKey: ["/api/capture/status"],
    queryFn: async () => (await apiRequest("GET", "/api/capture/status")).json() as Promise<CaptureStatusResponse>,
    refetchInterval: 15_000,
  });

  const capturing = Boolean(capture?.effectiveCapturing);
  const hbAgoMs = capture?.lastHeartbeatAgoMs ?? null;
  const hbMin = hbAgoMs != null ? Math.round(hbAgoMs / 60_000) : null;
  const quarantined = health?.dispatch?.quarantined ?? 0;

  return (
    <div className="hidden items-center gap-1.5 md:flex" data-testid="status-chips">
      <span className="inline-flex items-center whitespace-nowrap rounded-full border border-amber-500/40 px-2 py-1 font-mono text-[10px] font-semibold text-amber-500">
        HILLSBOROUGH · TAMPA
      </span>
      <Chip>
        <Dot tone="ok" />
        LIVE
      </Chip>
      <Chip>
        <Dot tone={health?.mongoConfigured ? "ok" : "crit"} />
        DB
      </Chip>
      <Chip>
        <Dot tone={capturing ? "ok" : "warn"} />
        {capturing ? "CAPTURING" : hbMin != null ? `IDLE · HB ${hbMin}M` : "NO DESK"}
      </Chip>
      {quarantined > 0 && (
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-1 font-mono text-[10px] font-semibold text-amber-500">
          {quarantined} QUARANTINED
        </span>
      )}
    </div>
  );
}
