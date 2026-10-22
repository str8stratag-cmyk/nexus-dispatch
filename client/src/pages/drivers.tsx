import { useCallback, useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

const REFRESH_MS = 20_000;
const SECRET_KEY = "dm_admin_secret";

interface DriverRow {
  telegramUserId: number;
  driverName: string;
  lat: number;
  lon: number;
  heading: number | null;
  at: string;
  ageSec: number;
  freshness: "fresh" | "stale" | "offline";
}
interface CallRow {
  eventId: number;
  driverName: string;
  address: string | null;
  acceptedAt: string;
  status: "pending" | "arrived" | "not_arrived" | "no_location";
  arrivedAt: string | null;
  closestM: number | null;
}
interface Board { drivers: DriverRow[]; calls: CallRow[] }

function fmtAge(s: number): string {
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}
const fmtTime = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString() : "—");

const STATUS: Record<CallRow["status"], { label: string; cls: string }> = {
  arrived: { label: "Arrived", cls: "bg-emerald-500/15 text-emerald-500" },
  not_arrived: { label: "Not arrived", cls: "bg-red-500/15 text-red-500" },
  no_location: { label: "No location", cls: "bg-amber-500/15 text-amber-500" },
  pending: { label: "Pending", cls: "bg-sky-500/15 text-sky-500" },
};
const COLOR = { fresh: "#10b981", stale: "#9ca3af", offline: "#4b5563" };

export default function DriversPage() {
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needSecret, setNeedSecret] = useState(false);
  const [secretInput, setSecretInput] = useState("");
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const mapEl = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const fitted = useRef(false);

  const load = useCallback(async () => {
    const secret = sessionStorage.getItem(SECRET_KEY);
    try {
      const res = await fetch("/api/drivers/board", { headers: secret ? { "x-admin-secret": secret } : {} });
      if (res.status === 401) { setNeedSecret(true); return; }
      if (!res.ok) throw new Error(`${res.status}`);
      setBoard(await res.json());
      setNeedSecret(false);
      setError(null);
      setUpdatedAt(new Date());
    } catch (e: any) {
      setError(`Refresh failed (${e?.message ?? e})`);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    if (!mapEl.current || map.current) return;
    map.current = L.map(mapEl.current).setView([27.95, -82.46], 11);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap contributors",
    }).addTo(map.current);
    layer.current = L.layerGroup().addTo(map.current);
    return () => { map.current?.remove(); map.current = null; };
  }, []);

  useEffect(() => {
    if (!board || !layer.current || !map.current) return;
    layer.current.clearLayers();
    for (const d of board.drivers) {
      const m = L.circleMarker([d.lat, d.lon], {
        radius: 9, color: COLOR[d.freshness], fillColor: COLOR[d.freshness],
        fillOpacity: d.freshness === "fresh" ? 0.9 : 0.4, weight: 2,
      });
      m.bindTooltip(`${d.driverName} · ${fmtAge(d.ageSec)} ago${d.freshness !== "fresh" ? " (STALE)" : ""}`, { permanent: true, direction: "right" });
      m.addTo(layer.current);
    }
    if (!fitted.current && board.drivers.length) {
      map.current.fitBounds(L.latLngBounds(board.drivers.map((d) => [d.lat, d.lon] as [number, number])).pad(0.3), { maxZoom: 14 });
      fitted.current = true;
    }
  }, [board]);

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <header className="flex items-center justify-between border-b border-border bg-card/80 px-4 py-2.5">
        <div className="flex items-center gap-3">
          <a href="#/" className="text-xs text-muted-foreground hover:underline">← Dispatch</a>
          <h1 className="text-base font-bold tracking-tight">DRIVERS</h1>
        </div>
        <span className="text-[11px] text-muted-foreground" data-testid="drivers-updated">
          {error ?? (updatedAt ? `Updated ${updatedAt.toLocaleTimeString()} · every ${REFRESH_MS / 1000}s` : "Loading…")}
        </span>
      </header>

      {needSecret && (
        <form
          className="flex items-center gap-2 border-b border-border p-3 text-sm"
          onSubmit={(e) => { e.preventDefault(); sessionStorage.setItem(SECRET_KEY, secretInput); setSecretInput(""); load(); }}
        >
          <span>Admin secret required:</span>
          <input type="password" className="rounded border border-border bg-background px-2 py-1" value={secretInput} onChange={(e) => setSecretInput(e.target.value)} data-testid="input-admin-secret" />
          <button className="rounded bg-primary px-3 py-1 text-primary-foreground" type="submit">Unlock</button>
        </form>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-2">
        <div className="flex min-h-[300px] flex-col">
          <div ref={mapEl} className="flex-1" data-testid="drivers-map" />
          <div className="flex flex-wrap gap-2 border-t border-border p-2 text-xs">
            {(board?.drivers ?? []).map((d) => (
              <span key={d.telegramUserId} className={`rounded px-2 py-0.5 ${d.freshness === "fresh" ? "bg-emerald-500/15 text-emerald-500" : "bg-muted text-muted-foreground line-through decoration-transparent opacity-60"}`}>
                {d.driverName} · {fmtAge(d.ageSec)}{d.freshness !== "fresh" ? " ⚠ stale" : ""}
              </span>
            ))}
            {board && board.drivers.length === 0 && <span className="text-muted-foreground">No driver locations yet — drivers send /startshift in the dispatch group.</span>}
          </div>
        </div>
        <div className="min-h-0 overflow-auto border-l border-border">
          <table className="w-full text-xs" data-testid="calls-table">
            <thead className="sticky top-0 bg-card">
              <tr className="text-left text-muted-foreground">
                <th className="p-2">Call</th><th className="p-2">Driver</th><th className="p-2">Address</th>
                <th className="p-2">Accepted</th><th className="p-2">Status</th><th className="p-2">Arrived</th><th className="p-2">Closest</th>
              </tr>
            </thead>
            <tbody>
              {(board?.calls ?? []).map((c) => (
                <tr key={c.eventId} className="border-t border-border">
                  <td className="p-2 font-mono">#{c.eventId}</td>
                  <td className="p-2">{c.driverName}</td>
                  <td className="p-2">{c.address ?? "—"}</td>
                  <td className="p-2">{fmtTime(c.acceptedAt)}</td>
                  <td className="p-2"><span className={`rounded px-2 py-0.5 ${STATUS[c.status]?.cls ?? ""}`}>{STATUS[c.status]?.label ?? c.status}</span></td>
                  <td className="p-2">{fmtTime(c.arrivedAt)}</td>
                  <td className="p-2">{c.closestM != null ? `${c.closestM} m` : "—"}</td>
                </tr>
              ))}
              {board && board.calls.length === 0 && (
                <tr><td colSpan={7} className="p-4 text-center text-muted-foreground">No accepted calls yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
