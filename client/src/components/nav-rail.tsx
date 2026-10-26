import { Radio, Send, ShieldAlert, Settings } from "lucide-react";

interface NavRailProps {
  active: string;
  onChange: (value: string) => void;
}

const ITEMS = [
  { value: "monitor", label: "Live", icon: Radio },
  { value: "manual", label: "Manual", icon: Send },
  { value: "quarantine", label: "Review", icon: ShieldAlert },
  { value: "settings", label: "Setup", icon: Settings },
] as const;

// Left icon rail replacing the centered TabsList on desktop (Saturday UI
// parity). Purely a nav affordance over the existing Tabs state in
// dispatch.tsx — no capture/runtime behavior here.
export default function NavRail({ active, onChange }: NavRailProps) {
  return (
    <nav
      className="hidden w-16 shrink-0 flex-col items-center gap-1.5 border-r border-border bg-card py-2.5 lg:flex"
      aria-label="Primary"
      data-testid="nav-rail"
    >
      <div className="mb-2 flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-sm font-extrabold text-primary-foreground">
        D
      </div>
      {ITEMS.map(({ value, label, icon: Icon }) => {
        const isActive = active === value;
        return (
          <button
            key={value}
            type="button"
            onClick={() => onChange(value)}
            className={`flex h-11 w-11 flex-col items-center justify-center gap-0.5 rounded-lg text-[10px] transition-colors ${
              isActive
                ? "bg-muted text-foreground shadow-[inset_3px_0_0_0_hsl(var(--primary))]"
                : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
            }`}
            aria-current={isActive ? "page" : undefined}
            data-testid={`rail-${value}`}
          >
            <Icon className="h-4 w-4" />
            {label}
          </button>
        );
      })}
      <div className="flex-1" />
    </nav>
  );
}
