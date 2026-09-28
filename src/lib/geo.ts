import polyline from "@mapbox/polyline";

export type LatLng = [number, number];

const EARTH_R = 6_371_000;
const rad = (d: number) => (d * Math.PI) / 180;

export function haversineM(a: LatLng, b: LatLng): number {
  const dLat = rad(b[0] - a[0]);
  const dLng = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Distance from point p to segment ab, in metres. Uses a local equirectangular
 * projection around p, which is accurate to well under a metre at quest scales.
 */
export function pointToSegmentM(p: LatLng, a: LatLng, b: LatLng): number {
  const k = Math.cos(rad(p[0]));
  const toXY = (q: LatLng) => [rad(q[1] - p[1]) * k * EARTH_R, rad(q[0] - p[0]) * EARTH_R] as const;
  const [ax, ay] = toXY(a);
  const [bx, by] = toXY(b);
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

export function decodePolyline(encoded: string | null | undefined): LatLng[] {
  if (!encoded) return [];
  return polyline.decode(encoded) as LatLng[];
}

export function encodePolyline(points: LatLng[]): string {
  return polyline.encode(points);
}

/**
 * Did the route pass within radiusM of the target? Checks segments, not just
 * vertices, because Strava's summary polyline is sparse: a runner can cross a
 * 75 m circle between two recorded points.
 */
export function routePassesWithin(route: LatLng[], target: LatLng, radiusM: number): boolean {
  if (route.length === 0) return false;
  if (route.length === 1) return haversineM(route[0], target) <= radiusM;
  for (let i = 1; i < route.length; i++) {
    if (pointToSegmentM(target, route[i - 1], route[i]) <= radiusM) return true;
  }
  return false;
}

/** Closest approach of the route to the target, in metres (for logging and the UI). */
export function closestApproachM(route: LatLng[], target: LatLng): number | null {
  if (route.length === 0) return null;
  if (route.length === 1) return haversineM(route[0], target);
  let best = Infinity;
  for (let i = 1; i < route.length; i++) best = Math.min(best, pointToSegmentM(target, route[i - 1], route[i]));
  return best;
}

/** Point `distM` metres from `from` along a compass bearing (degrees). */
export function offsetPoint(from: LatLng, bearingDeg: number, distM: number): LatLng {
  const d = distM / EARTH_R;
  const br = rad(bearingDeg);
  const lat1 = rad(from[0]);
  const lng1 = rad(from[1]);
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(br));
  const lng2 = lng1 + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return [(lat2 * 180) / Math.PI, (lng2 * 180) / Math.PI];
}
