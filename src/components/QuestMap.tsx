"use client";

import "leaflet/dist/leaflet.css";
import { useEffect } from "react";
import { Circle, CircleMarker, MapContainer, Polyline, TileLayer, Tooltip, useMap, useMapEvents } from "react-leaflet";

export type QuestPin = { id: number; name: string; lat: number; lng: number; radiusM: number; active: boolean };

type Props = {
  quests: QuestPin[];
  draft?: { lat: number; lng: number; radiusM: number } | null;
  onPick?: (lat: number, lng: number) => void;
  route?: [number, number][];
  center?: [number, number];
  zoom?: number;
  className?: string;
};

function ClickHandler({ onPick }: { onPick?: (lat: number, lng: number) => void }) {
  useMapEvents({
    click(e) {
      onPick?.(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
}

function FitRoute({ route }: { route?: [number, number][] }) {
  const map = useMap();
  useEffect(() => {
    if (route && route.length > 1) map.fitBounds(route, { padding: [30, 30] });
  }, [map, route]);
  return null;
}

// Default: downtown Toronto.
const DEFAULT_CENTER: [number, number] = [43.6532, -79.3832];

export default function QuestMap({ quests, draft, onPick, route, center, zoom = 13, className }: Props) {
  const start = center ?? (quests[0] ? [quests[0].lat, quests[0].lng] : DEFAULT_CENTER);
  return (
    <MapContainer
      center={start as [number, number]}
      zoom={zoom}
      className={className ?? "h-[420px] w-full rounded-xl"}
      style={{ background: "#1b2027", cursor: onPick ? "crosshair" : undefined }}
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <ClickHandler onPick={onPick} />
      <FitRoute route={route} />
      {quests.map((q) => (
        <Circle
          key={q.id}
          center={[q.lat, q.lng]}
          radius={q.radiusM}
          pathOptions={{ color: q.active ? "#ff6b35" : "#8b97a4", weight: 2, fillOpacity: 0.25 }}
        >
          <Tooltip permanent direction="top" offset={[0, -8]}>
            {q.name}
          </Tooltip>
        </Circle>
      ))}
      {draft && (
        <>
          <Circle center={[draft.lat, draft.lng]} radius={draft.radiusM} pathOptions={{ color: "#c8f53a", weight: 2, fillOpacity: 0.25 }} />
          <CircleMarker center={[draft.lat, draft.lng]} radius={5} pathOptions={{ color: "#c8f53a", fillOpacity: 1 }} />
        </>
      )}
      {route && route.length > 1 && <Polyline positions={route} pathOptions={{ color: "#c8f53a", weight: 4 }} />}
    </MapContainer>
  );
}
