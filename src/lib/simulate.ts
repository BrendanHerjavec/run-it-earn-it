import type { Goal } from "@/db/schema";
import { encodePolyline, offsetPoint, type LatLng } from "./geo";
import type { StravaActivity } from "./strava";

export type SimulateInput = {
  distanceKm: number;
  paceSecPerKm: number;
  sportType: string;
  /** If set, the generated route runs straight through this quest's pin. */
  quest?: Pick<Goal, "lat" | "lng" | "name"> | null;
  /** Where to draw a quest-free loop. Defaults to downtown Toronto. */
  home?: LatLng;
  now?: Date;
};

const TORONTO: LatLng = [43.6532, -79.3832];

/**
 * A Strava-shaped activity for demos. Simulated IDs are negative so they can
 * never collide with real Strava IDs, and the same pipeline processes them.
 */
export function buildSimulatedActivity(input: SimulateInput): StravaActivity {
  const now = input.now ?? new Date();
  const distanceM = Math.round(input.distanceKm * 1000);
  const movingTime = Math.round(input.distanceKm * input.paceSecPerKm);
  let route: LatLng[];

  if (input.quest?.lat != null && input.quest?.lng != null) {
    // Out-and-back through the pin: quarter-distance either side, so total ≈ distance.
    const q: LatLng = [input.quest.lat, input.quest.lng];
    const a = offsetPoint(q, 225, distanceM / 4);
    const b = offsetPoint(q, 45, distanceM / 4);
    route = [a, q, b, q, a];
  } else {
    // A circular loop whose circumference is the run distance, well east of home.
    const r = distanceM / (2 * Math.PI);
    const centre = offsetPoint(input.home ?? TORONTO, 90, r + 3000);
    route = Array.from({ length: 33 }, (_, i) => offsetPoint(centre, (i * 360) / 32, r));
  }

  return {
    id: -now.getTime(),
    name: input.quest?.name ? `Demo run via ${input.quest.name}` : `Demo ${input.distanceKm} km run`,
    sport_type: input.sportType,
    distance: distanceM,
    moving_time: movingTime,
    elapsed_time: movingTime + 60,
    average_speed: distanceM / Math.max(1, movingTime),
    start_date: new Date(now.getTime() - movingTime * 1000).toISOString(),
    map: { summary_polyline: encodePolyline(route) },
  };
}
