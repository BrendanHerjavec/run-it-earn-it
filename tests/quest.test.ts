import { describe, expect, it } from "vitest";
import { closestApproachM, decodePolyline, encodePolyline, haversineM, offsetPoint, routePassesWithin, type LatLng } from "@/lib/geo";
import { buildSimulatedActivity } from "@/lib/simulate";

const QUEST: LatLng = [43.6534, -79.3841]; // Nathan Phillips Square

describe("quest matching", () => {
  it("hits when a recorded point is inside the radius", () => {
    const near = offsetPoint(QUEST, 90, 40);
    const route: LatLng[] = [offsetPoint(QUEST, 270, 800), near, offsetPoint(QUEST, 90, 800)];
    expect(routePassesWithin(route, QUEST, 75)).toBe(true);
  });

  it("hits when the route crosses the circle between two sparse points", () => {
    // Points 1 km apart on either side; the straight line between them passes 30 m from the pin.
    const a = offsetPoint(offsetPoint(QUEST, 0, 30), 270, 500);
    const b = offsetPoint(offsetPoint(QUEST, 0, 30), 90, 500);
    expect(haversineM(a, QUEST)).toBeGreaterThan(400);
    expect(haversineM(b, QUEST)).toBeGreaterThan(400);
    expect(routePassesWithin([a, b], QUEST, 75)).toBe(true);
    expect(closestApproachM([a, b], QUEST)).toBeCloseTo(30, 0);
  });

  it("misses when the route stays outside the radius", () => {
    const a = offsetPoint(offsetPoint(QUEST, 0, 120), 270, 500);
    const b = offsetPoint(offsetPoint(QUEST, 0, 120), 90, 500);
    expect(routePassesWithin([a, b], QUEST, 75)).toBe(false);
    expect(routePassesWithin([a, b], QUEST, 150)).toBe(true);
  });

  it("handles empty and single-point routes", () => {
    expect(routePassesWithin([], QUEST, 75)).toBe(false);
    expect(routePassesWithin([offsetPoint(QUEST, 45, 10)], QUEST, 75)).toBe(true);
  });

  it("survives a round trip through Strava's polyline encoding", () => {
    const route: LatLng[] = [offsetPoint(QUEST, 200, 600), offsetPoint(QUEST, 20, 600)];
    const decoded = decodePolyline(encodePolyline(route));
    expect(routePassesWithin(decoded, QUEST, 75)).toBe(true);
  });

  it("simulated runs route through the chosen quest, and loops avoid it", () => {
    const via = buildSimulatedActivity({ distanceKm: 5, paceSecPerKm: 330, sportType: "Run", quest: { lat: QUEST[0], lng: QUEST[1], name: "Q" } });
    expect(routePassesWithin(decodePolyline(via.map?.summary_polyline), QUEST, 75)).toBe(true);
    const loop = buildSimulatedActivity({ distanceKm: 5, paceSecPerKm: 330, sportType: "Run", home: QUEST });
    expect(routePassesWithin(decodePolyline(loop.map?.summary_polyline), QUEST, 75)).toBe(false);
    expect(via.id).toBeLessThan(0);
  });
});
