import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

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
}

// v2: Build popup DOM safely to avoid XSS from DB values.
function buildPopupContent(marker: DispatchMarker): HTMLElement {
  const container = document.createElement("div");
  container.style.minWidth = "220px";
  container.style.fontFamily = "var(--font-sans, ui-sans-serif, system-ui, sans-serif)";

  const signal = document.createElement("div");
  signal.style.fontWeight = "700";
  signal.style.color = "hsl(38 92% 55%)";
  signal.style.marginBottom = "4px";
  signal.textContent = marker.signalType || "Unknown Signal";
  container.appendChild(signal);

  const meta = document.createElement("div");
  meta.style.fontSize = "12px";
  meta.style.color = "hsl(220 6% 65%)";
  meta.style.marginBottom = "8px";
  meta.textContent = `${marker.district} • ${new Date(marker.createdAt).toLocaleTimeString()}`;
  container.appendChild(meta);

  const address = document.createElement("div");
  address.style.fontWeight = "600";
  address.style.marginBottom = "4px";
  address.textContent = marker.crossStreet
    ? `${marker.address} & ${marker.crossStreet}`
    : marker.address || "Address unknown";
  container.appendChild(address);

  if (marker.geocodedRoad) {
    const roadRef = document.createElement("div");
    roadRef.style.fontSize = "11px";
    roadRef.style.color = "hsl(38 92% 55%)";
    roadRef.style.marginBottom = "8px";
    roadRef.textContent = `🛣️ Road x-ref: ${marker.geocodedRoad}`;
    container.appendChild(roadRef);
  }

  if (marker.description) {
    const desc = document.createElement("div");
    desc.style.marginBottom = "8px";
    desc.textContent = marker.description;
    container.appendChild(desc);
  }

  const transcript = document.createElement("div");
  transcript.style.fontSize = "12px";
  transcript.style.color = "hsl(220 6% 55%)";
  transcript.style.borderTop = "1px solid hsl(220 9% 17%)";
  transcript.style.paddingTop = "6px";
  transcript.style.marginTop = "6px";
  transcript.textContent = marker.transcript || "No transcript";
  container.appendChild(transcript);

  return container;
}

export default function DispatchMap({ markers }: DispatchMapProps) {
  const mapRef = useRef<L.Map | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const markerLayerRef = useRef<L.LayerGroup | null>(null);
  const hasFittedMarkersRef = useRef(false);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = L.map(containerRef.current, {
      center: [27.9506, -82.4572], // Tampa, FL
      zoom: 11,
      zoomControl: true,
      attributionControl: true,
    });

    const baseLayer = L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
      subdomains: "abcd",
      maxZoom: 20,
    }).addTo(map);

    // Roads overlay for cross-referencing dispatch locations against real road names.
    const roadsOverlay = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      subdomains: "abc",
      maxZoom: 20,
      opacity: 0.35,
    });

    L.control.layers(
      { "Dark": baseLayer },
      { "Roads": roadsOverlay },
      { collapsed: false, position: "topright" }
    ).addTo(map);

    // Hillsborough County, FL boundary for cross-reference context.
    const countyBounds: L.LatLngExpression[] = [
      [27.5706, -82.8237],
      [27.5706, -82.0540],
      [28.1734, -82.0540],
      [28.1734, -82.8237],
    ];
    L.polygon(countyBounds, {
      color: "hsl(38 92% 55%)",
      weight: 2,
      fillColor: "hsl(38 92% 55%)",
      fillOpacity: 0.05,
      dashArray: "6, 8",
    })
      .bindPopup("Hillsborough County service area")
      .addTo(map);

    markerLayerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;

    // Fix for container not having proper size initially
    setTimeout(() => map.invalidateSize(), 100);

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!mapRef.current || !markerLayerRef.current) return;

    markerLayerRef.current.clearLayers();

    markers.forEach((marker) => {
      if (!marker.lat || !marker.lng) return;

      // Accepted calls are dimmed; active calls stay red/alert.
      const isAccepted = marker.status === "accepted";
      const hue = isAccepted ? 220 : 0;
      const bg = isAccepted ? "hsl(220 20% 35%)" : "hsl(0 72% 48%)";
      const shadow = isAccepted ? "hsl(220 20% 35% / 0.4)" : "hsl(0 72% 48% / 0.6)";
      const emoji = isAccepted ? "🔒" : "🚨";

      // Custom alert icon
      const icon = L.divIcon({
        className: "dispatch-marker",
        html: `<div style="
          width: 28px;
          height: 28px;
          border-radius: 50%;
          background: ${bg};
          border: 3px solid hsl(0 0% 100%);
          box-shadow: 0 0 12px ${shadow};
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 14px;
        ">${emoji}</div>`,
        iconSize: [28, 28],
        iconAnchor: [14, 14],
      });

      L.marker([marker.lat, marker.lng], { icon })
        .bindPopup(buildPopupContent(marker))
        .addTo(markerLayerRef.current!);
    });

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
  }, [markers]);

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

  return <div ref={containerRef} className="h-full w-full" data-testid="dispatch-map" />;
}
