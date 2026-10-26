import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { formatAddress, severityOf } from "@/lib/monitor-ui";

// Tampa / Hillsborough home view (unchanged from the pre-Saturday board).
const HOME_CENTER: L.LatLngExpression = [27.9506, -82.4572];
const HOME_ZOOM = 11;

interface DispatchMarker {
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
}

interface DispatchMapProps {
  markers: DispatchMarker[];
  selectedId?: number | null;
  onSelect?: (id: number) => void;
  /** Bump `n` to pan/zoom to event `id` (queue or transcript click). */
  focus?: { id: number; n: number } | null;
}

// Hover label built with textContent (DB values are untrusted — no HTML).
function buildTooltipContent(marker: DispatchMarker): HTMLElement {
  const container = document.createElement("div");
  container.style.fontFamily = "var(--sat-mono, ui-monospace, monospace)";
  container.style.fontSize = "11px";
  const signal = document.createElement("div");
  signal.style.fontWeight = "700";
  signal.textContent = marker.signalType || "Unknown signal";
  container.appendChild(signal);
  const address = document.createElement("div");
  address.textContent = formatAddress(marker);
  container.appendChild(address);
  return container;
}

export default function DispatchMap({ markers, selectedId = null, onSelect, focus = null }: DispatchMapProps) {
  const mapRef = useRef<L.Map | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const markerLayerRef = useRef<L.LayerGroup | null>(null);
  const hasFittedMarkersRef = useRef(false);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const [showPins, setShowPins] = useState(true);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = L.map(containerRef.current, {
      center: HOME_CENTER, // Tampa, FL
      zoom: HOME_ZOOM,
      zoomControl: false, // re-added bottom-left (Saturday layout)
      attributionControl: true,
    });

    // Carto dark_all now returns watermark tiles ("API KEY REQUIRED" /
    // carto.com/basemaps/apikey). Use keyless Esri canvas — no Vite secrets.
    // OSM volunteer tiles are often blocked (418) from desk browsers; Esri
    // World Street Map is the roads/detail overlay instead.
    const baseLayer = L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}",
      {
        attribution:
          'Tiles &copy; <a href="https://www.esri.com/">Esri</a> &mdash; Esri, HERE, Garmin, FAO, NOAA, USGS',
        maxZoom: 16,
      }
    ).addTo(map);

    const labelsOverlay = L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}",
      {
        attribution: 'Labels &copy; Esri',
        maxZoom: 16,
        opacity: 0.9,
      }
    ).addTo(map);

    const roadsOverlay = L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}",
      {
        attribution: 'Streets &copy; Esri',
        maxZoom: 19,
        opacity: 0.45,
      }
    );

    L.control.layers(
      { Dark: baseLayer },
      { Labels: labelsOverlay, Roads: roadsOverlay },
      { collapsed: false, position: "topright" }
    ).addTo(map);

    L.control.zoom({ position: "bottomleft" }).addTo(map);

    // Hillsborough County, FL boundary for cross-reference context.
    const countyBounds: L.LatLngExpression[] = [
      [27.5706, -82.8237],
      [27.5706, -82.0540],
      [28.1734, -82.0540],
      [28.1734, -82.8237],
    ];
    L.polygon(countyBounds, {
      color: "#f5a524",
      weight: 2,
      fillColor: "#f5a524",
      fillOpacity: 0.05,
      dashArray: "6, 8",
    })
      .bindTooltip("Hillsborough County service area", { sticky: true })
      .addTo(map);

    markerLayerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;

    // 3-pane board often mounts the map before the center column has its final
    // height; invalidate repeatedly until layout settles (ResizeObserver below
    // covers later resizes).
    const invalidate = () => {
      try {
        map.invalidateSize({ animate: false });
      } catch {
        /* map may already be removed */
      }
    };
    invalidate();
    const raf = requestAnimationFrame(invalidate);
    const t1 = window.setTimeout(invalidate, 50);
    const t2 = window.setTimeout(invalidate, 250);
    const t3 = window.setTimeout(invalidate, 1000);

    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      window.clearTimeout(t3);
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!mapRef.current || !markerLayerRef.current) return;

    markerLayerRef.current.clearLayers();

    if (showPins) {
      markers.forEach((marker) => {
        if (!marker.lat || !marker.lng) return;
        const sev = severityOf(marker.signalType);
        const isSelected = marker.id === selectedId;
        const cls = [
          "sat-pin",
          sev,
          marker.status === "accepted" ? "accepted" : "",
          marker.status === "resolved" ? "resolved" : "",
          isSelected ? "sel" : "",
        ].join(" ");
        const icon = L.divIcon({
          className: "dispatch-marker",
          html: `<div class="${cls}"></div>`,
          iconSize: [18, 18],
          iconAnchor: [9, 9],
        });
        L.marker([marker.lat, marker.lng], {
          icon,
          zIndexOffset: isSelected ? 1000 : sev === "crit" ? 500 : 0,
          keyboard: true,
          title: marker.signalType || "Incident",
        })
          .bindTooltip(buildTooltipContent(marker), { direction: "top", offset: [0, -10] })
          .on("click", () => onSelectRef.current?.(marker.id))
          .addTo(markerLayerRef.current!);
      });
    }

    const validMarkers = markers.filter((m): m is typeof m & { lat: number; lng: number } =>
      Number.isFinite(m.lat) && Number.isFinite(m.lng)
    );
    if (validMarkers.length && !hasFittedMarkersRef.current) {
      mapRef.current.fitBounds(
        L.latLngBounds(validMarkers.map((marker) => [marker.lat, marker.lng])),
        { padding: [24, 24], maxZoom: 14 }
      );
      hasFittedMarkersRef.current = true;
    }
  }, [markers, selectedId, showPins]);

  // Pan to a call selected from the queue / transcripts. Map clicks select
  // without moving the view (same as the Saturday prototype).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !focus) return;
    const m = markers.find((x) => x.id === focus.id);
    if (!m || !Number.isFinite(m.lat) || !Number.isFinite(m.lng)) return;
    try {
      map.invalidateSize({ animate: false });
      map.setView([m.lat as number, m.lng as number], Math.max(map.getZoom(), 14), { animate: true });
    } catch {
      /* map may be mid-teardown */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

  const fitAll = () => {
    const map = mapRef.current;
    if (!map) return;
    const pts = markers
      .filter((m) => Number.isFinite(m.lat) && Number.isFinite(m.lng) && m.status !== "resolved")
      .map((m) => [m.lat as number, m.lng as number] as L.LatLngTuple);
    if (pts.length) map.fitBounds(L.latLngBounds(pts), { padding: [60, 60], maxZoom: 14 });
  };
  const goHome = () => mapRef.current?.setView(HOME_CENTER, HOME_ZOOM);

  // Invalidate size when tab becomes visible
  useEffect(() => {
    const observer = new ResizeObserver(() => {
      if (mapRef.current) {
        mapRef.current.invalidateSize();
      }
    });
    if (containerRef.current) {
      observer.observe(containerRef.current);
    }
    return () => observer.disconnect();
  }, []);

  // absolute inset fill: parent must be position:relative with non-zero height
  // (see dispatch.tsx map pane). Inline minHeight avoids a grey 0-height Leaflet
  // pane if flex sizing races on first paint.
  return (
    <>
    <div className="sat-maptools" role="toolbar" aria-label="Map tools">
      <button type="button" className={showPins ? "on" : ""} aria-pressed={showPins} onClick={() => setShowPins((v) => !v)} data-testid="map-tool-incidents">
        Incidents
      </button>
      <button type="button" onClick={fitAll} data-testid="map-tool-fit">
        Fit all
      </button>
      <button type="button" onClick={goHome} data-testid="map-tool-home">
        Tampa
      </button>
    </div>
    <div
      ref={containerRef}
      className="absolute inset-0 h-full w-full min-h-[200px] bg-[var(--sat-map-bg)]"
      style={{ zIndex: 0 }}
      data-testid="dispatch-map"
    />
    </>
  );
}
