import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

interface DispatchMarker {
  id: number;
  lat: number;
  lng: number;
  address: string;
  signalType: string;
  description: string;
  district: string;
  transcript: string;
  createdAt: string;
}

interface DispatchMapProps {
  markers: DispatchMarker[];
}

export default function DispatchMap({ markers }: DispatchMapProps) {
  const mapRef = useRef<L.Map | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const markerLayerRef = useRef<L.LayerGroup | null>(null);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = L.map(containerRef.current, {
      center: [27.9506, -82.4572], // Tampa, FL
      zoom: 11,
      zoomControl: true,
      attributionControl: true,
    });

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19,
    }).addTo(map);

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

      // Custom alert icon
      const icon = L.divIcon({
        className: "dispatch-marker",
        html: `<div style="
          width: 28px;
          height: 28px;
          border-radius: 50%;
          background: hsl(0 72% 48%);
          border: 3px solid hsl(0 0% 100%);
          box-shadow: 0 0 12px hsl(0 72% 48% / 0.6);
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 14px;
        ">🚨</div>`,
        iconSize: [28, 28],
        iconAnchor: [14, 14],
      });

      const popupContent = `
        <div style="min-width: 220px; font-family: var(--font-sans);">
          <div style="font-weight: 700; color: hsl(38 92% 55%); margin-bottom: 4px;">${marker.signalType || "Unknown Signal"}</div>
          <div style="font-size: 12px; color: hsl(220 6% 65%); margin-bottom: 8px;">${marker.district} • ${new Date(marker.createdAt).toLocaleTimeString()}</div>
          <div style="font-weight: 600; margin-bottom: 4px;">${marker.address || "Address unknown"}</div>
          ${marker.description ? `<div style="margin-bottom: 8px;">${marker.description}</div>` : ""}
          <div style="font-size: 12px; color: hsl(220 6% 55%); border-top: 1px solid hsl(220 9% 17%); padding-top: 6px; margin-top: 6px;">${marker.transcript || "No transcript"}</div>
        </div>
      `;

      L.marker([marker.lat, marker.lng], { icon })
        .bindPopup(popupContent)
        .addTo(markerLayerRef.current!);
    });
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
