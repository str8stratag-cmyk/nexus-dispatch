import { useEffect, useState, type ReactNode } from "react";
import { ExternalLink, Moon, PanelRight, Sun } from "lucide-react";
import type { CaptureUiState } from "@/components/audio-panel";

export type MonitorView = "monitor" | "manual" | "quarantine" | "settings";

// Stroke icons from the Saturday prototype (radar / send / shield / gear).
const ICONS: Record<MonitorView, ReactNode> = {
  monitor: (
    <>
      <path d="M4 12a8 8 0 0 1 16 0M7.5 12a4.5 4.5 0 0 1 9 0M12 12v.01" />
      <path d="M12 12l6 8M12 12l-6 8" />
    </>
  ),
  manual: <path d="M4 12l16-8-6 16-3-7z" />,
  quarantine: (
    <>
      <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" />
      <path d="M12 8v5M12 16v.01" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2" />
    </>
  ),
};

const RAIL_ITEMS: Array<[MonitorView, string, string]> = [
  ["monitor", "Live", "Live Monitor"],
  ["manual", "Manual", "Manual Dispatch"],
  ["quarantine", "Review", "Quarantine review"],
  ["settings", "Setup", "Settings"],
];

export function Rail({ view, onView }: { view: MonitorView; onView: (v: MonitorView) => void }) {
  return (
    <nav className="sat-rail" aria-label="Primary">
      <div className="sat-logo" aria-hidden>
        H
      </div>
      {RAIL_ITEMS.map(([key, label, title]) => (
        <button
          key={key}
          type="button"
          className={`sat-rail-btn ${view === key ? "on" : ""}`}
          aria-current={view === key ? "page" : undefined}
          title={title}
          onClick={() => onView(key)}
          data-testid={`tab-${key}`}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            {ICONS[key]}
          </svg>
          {label}
        </button>
      ))}
      <div className="sat-rail-sp" />
    </nav>
  );
}

function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(t);
  }, []);
  return (
    <span className="sat-clock" data-testid="header-clock">
      {now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}
    </span>
  );
}

export interface HealthSnapshot {
  ok?: boolean;
  mongoConfigured?: boolean;
  dispatch?: { quarantined?: number; retryQueued?: number; reviewEvents?: number };
}

interface TopBarProps {
  sourceName: string;
  capture: CaptureUiState | null;
  health: HealthSnapshot | undefined;
  healthError: boolean;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  /** Phone: queue ↔ map tabs (only rendered on the Live view). */
  phonePane?: "queue" | "map";
  onPhonePane?: (p: "queue" | "map") => void;
  /** Tablet: open/close the transcripts + detail drawer. */
  onToggleDrawer?: () => void;
}

export function TopBar({
  sourceName,
  capture,
  health,
  healthError,
  theme,
  onToggleTheme,
  phonePane,
  onPhonePane,
  onToggleDrawer,
}: TopBarProps) {
  const desk = sourceName || "desk";
  let captureChip: { dot: string; text: string; live: boolean };
  if (!capture) captureChip = { dot: "idle", text: `${desk} starting`, live: false };
  else if (capture.capturing) captureChip = { dot: "", text: `${desk} capturing`, live: true };
  else if (capture.standby) captureChip = { dot: "warn", text: `${desk} standby`, live: false };
  else if (capture.error) captureChip = { dot: "crit", text: `${desk} capture error`, live: false };
  else if (!capture.autoCapture) captureChip = { dot: "warn", text: `${desk} capture off`, live: false };
  else captureChip = { dot: "warn", text: `${desk} idle`, live: false };

  const dbDot = healthError ? "crit" : health?.mongoConfigured ? "" : health ? "crit" : "idle";
  const quarantined = health?.dispatch?.quarantined ?? 0;
  const retryQueued = health?.dispatch?.retryQueued ?? 0;
  const inIframe = typeof window !== "undefined" && window.self !== window.top;

  return (
    <header className="sat-top">
      <h1>
        Dispatch Monitor · Tampa
        <small>Hillsborough County, FL · Traffic incident detection</small>
      </h1>
      {phonePane && onPhonePane && (
        <div className="sat-phone-toggle" role="group" aria-label="Show">
          <button type="button" className={phonePane === "queue" ? "on" : ""} onClick={() => onPhonePane("queue")}>
            Calls
          </button>
          <button type="button" className={phonePane === "map" ? "on" : ""} onClick={() => onPhonePane("map")}>
            Map
          </button>
        </div>
      )}
      <div className="sat-chips" data-testid="header-chips">
        <span className={`sat-chip ${captureChip.live ? "live" : ""}`} data-testid="chip-capture">
          <span className={`sat-dot ${captureChip.dot}`} />
          {captureChip.live ? "LIVE · " : ""}
          {captureChip.text}
        </span>
        <span className="sat-chip" data-testid="chip-db" title={healthError ? "/api/health unreachable" : undefined}>
          <span className={`sat-dot ${dbDot}`} />
          {healthError ? "Server ?" : "DB"}
        </span>
        {retryQueued > 0 && (
          <span className="sat-chip" style={{ color: "var(--sat-warn)", borderColor: "var(--sat-warn)" }}>
            <span className="sat-dot warn" />
            {retryQueued} retry queued
          </span>
        )}
        <span className="sat-chip" title="Quarantined since this server started">
          <span className={`sat-dot ${quarantined > 0 ? "warn" : ""}`} />
          {quarantined} quarantined
        </span>
      </div>
      <Clock />
      {onToggleDrawer && (
        <button
          type="button"
          className="sat-iconbtn sat-feed-toggle"
          onClick={onToggleDrawer}
          title="Transcripts & incident"
          aria-label="Toggle transcripts and incident panel"
        >
          <PanelRight />
        </button>
      )}
      {inIframe && (
        <button
          type="button"
          className="sat-iconbtn"
          onClick={() => window.open(window.location.href, "_blank")}
          title="Open in new tab"
          aria-label="Open in new tab"
          data-testid="header-open-tab"
        >
          <ExternalLink />
        </button>
      )}
      <button
        type="button"
        className="sat-iconbtn"
        onClick={onToggleTheme}
        title="Toggle theme"
        aria-label="Toggle theme"
        data-testid="theme-toggle"
      >
        {theme === "dark" ? <Sun /> : <Moon />}
      </button>
    </header>
  );
}
