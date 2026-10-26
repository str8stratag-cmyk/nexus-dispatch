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
