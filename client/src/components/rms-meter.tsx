import { useRef } from "react";

interface RmsMeterProps {
  rms: number;
  active: boolean;
  /** Single-row bar for the 3-pane top strip (no SIGNAL/dB chrome). */
  compact?: boolean;
}

export default function RmsMeter({ rms, active, compact = false }: RmsMeterProps) {
  // Convert RMS (0-1) to a percentage with some scaling
  const percentage = Math.min(100, Math.max(0, rms * 300));
  const segments = compact ? 16 : 20;
  const litSegments = Math.round((percentage / 100) * segments);

  const bar = (
    <div className={`flex gap-0.5 ${compact ? "h-2.5 w-28 sm:w-36" : "h-3"}`} data-testid="rms-bar">
      {Array.from({ length: segments }).map((_, i) => {
        const isLit = i < litSegments;
        let color = "bg-muted";
        if (isLit) {
          if (i < segments * 0.4) color = "bg-green-500";
          else if (i < segments * 0.7) color = "bg-yellow-500";
          else if (i < segments * 0.85) color = "bg-orange-500";
          else color = "bg-red-500";
        }
        return (
          <div
            key={i}
            className={`flex-1 rounded-sm transition-colors duration-75 ${color} ${isLit ? "" : "opacity-20"}`}
            data-testid={`rms-segment-${i}`}
          />
        );
      })}
    </div>
  );

  if (compact) {
    return (
      <div className="flex items-center gap-2 min-w-0" data-testid="rms-meter">
        <span className={`text-[10px] font-mono shrink-0 ${active ? "text-green-500" : "text-muted-foreground"}`}>
          {active ? "LIVE" : "IDLE"}
        </span>
        {bar}
        <span className="text-[10px] font-mono text-muted-foreground tabular-nums w-8 shrink-0">
          {active ? `${Math.round(percentage)}%` : "--"}
        </span>
      </div>
    );
  }

  return (
    <div className="space-y-2" data-testid="rms-meter">
      <div className="flex items-center justify-between">
        <span className="text-xs font-mono text-muted-foreground">SIGNAL</span>
        <span className={`text-xs font-mono ${active ? "text-green-500" : "text-muted-foreground"}`}>
          {active ? "● LIVE" : "○ IDLE"}
        </span>
      </div>
      {bar}
      <div className="flex justify-between text-[10px] font-mono text-muted-foreground">
        <span>-40dB</span>
        <span>{active ? `${Math.round(percentage)}%` : "--"}</span>
        <span>0dB</span>
      </div>
    </div>
  );
}

/**
 * Saturday bottom-strip meter: gradient bar, decaying peak tick, dB readout.
 * Same `rms` value the other meters use (no capture-side change); the peak
 * hold is display-only.
 */
export function StripMeter({ rms, active, label }: { rms: number; active: boolean; label: string }) {
  // Same scaling as RmsMeter so all meters agree.
  const level = active ? Math.min(1, Math.max(0, rms * 3)) : 0;
  const peakRef = useRef({ value: 0, at: 0 });
  const now = performance.now();
  const decayed = Math.max(0, peakRef.current.value - ((now - peakRef.current.at) / 1000) * 0.25);
  if (level >= decayed) {
    peakRef.current = { value: level, at: now };
  } else {
    peakRef.current = { value: decayed, at: now };
  }
  const db = active && rms > 0 ? Math.max(-60, 20 * Math.log10(rms)) : null;
  return (
    <>
      <div
        className="sat-rms"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(level * 100)}
        data-testid="rms-meter"
      >
        <i style={{ width: `${level * 100}%` }} />
        <b style={{ left: `calc(${peakRef.current.value * 100}% - 2px)`, opacity: active ? 0.85 : 0 }} />
      </div>
      <span className="sat-db">{db === null ? (active ? "-∞ dB" : "idle") : `${db.toFixed(0)} dB`}</span>
    </>
  );
}
