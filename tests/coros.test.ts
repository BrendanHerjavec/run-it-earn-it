import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DB } from "@/db";
import { activities, rewardEvents, users } from "@/db/schema";
import { fitToActivity, parseSportRecords, syncCoros, type CorosRunRef, type CorosSource } from "@/lib/coros-sync";
import { decodePolyline, offsetPoint, routePassesWithin, type LatLng } from "@/lib/geo";
import { addGoal, freshDb, seedWishlist } from "./helpers";

// Verbatim shape of a real querySportRecords response (2026-09-29).
const LIST_TEXT =
  '"Sport Records — 2025-09-01 to 2026-09-29 (2 records)\\n========================\\n\\n1. Outdoor Run — 2026-03-21\\n   Location: Toronto Run\\n   Start Coordinates: 43.653200, -79.383200\\n   Time Window: startTimestamp=1774117014 | endTimestamp=1774117544\\n   Duration: 8:50 | Distance: 786 m\\n   Average Pace: 11:14 /km | Avg HR: 101 bpm | Calories: 58 kcal\\n   LabelId: 470000000000000001 | SportType: 100\\n\\n2. Trail Run — 2026-02-20\\n   Location: Trail Run\\n   Time Window: startTimestamp=1771573436 | endTimestamp=1771573449\\n   Duration: 0:13\\n | Calories: 0 kcal\\n   LabelId: 470000000000000002 | SportType: 102"';

describe("COROS list parsing", () => {
  it("parses labelId, sport, time window, distance and duration from the text response", () => {
    const refs = parseSportRecords(LIST_TEXT);
    expect(refs).toHaveLength(2);
    expect(refs[0]).toEqual({
      labelId: "470000000000000001", // too big for a JS number: kept as a string
      sportType: 100,
      startTs: 1774117014,
      endTs: 1774117544,
      distanceM: 786,
      durationS: 530,
      title: "Outdoor Run",
    });
    expect(refs[1]).toMatchObject({ labelId: "470000000000000002", sportType: 102, distanceM: undefined, durationS: 13 });
  });

  it("understands km distances and h:mm:ss durations", () => {
    const [r] = parseSportRecords(
      "1. Outdoor Run — 2026-09-28\n   Time Window: startTimestamp=100 | endTimestamp=200\n   Duration: 1:02:03 | Distance: 10.52 km\n   LabelId: 1 | SportType: 100",
    );
    expect(r).toMatchObject({ distanceM: 10520, durationS: 3723 });
  });
});

describe("FIT to activity", () => {
  const ref: CorosRunRef = { labelId: "9", sportType: 102, startTs: 1774117014, endTs: 1774117544, title: "Trail Run" };

  it("uses the FIT session and GPS track", () => {
    const pts: LatLng[] = Array.from({ length: 2000 }, (_, i) => offsetPoint([43.6532, -79.3832], 90, i * 3));
    const a = fitToActivity(ref, {
      sessions: [{ sport: "running", start_time: new Date("2026-03-21T18:16:54Z"), total_distance: 786.08, total_timer_time: 530, avg_speed: 1.483 }],
      records: [{}, ...pts.map(([lat, lng]) => ({ position_lat: lat, position_long: lng }))],
    });
    expect(a).toMatchObject({ sport_type: "TrailRun", distance: 786.08, moving_time: 530, average_speed: 1.483, start_date: "2026-03-21T18:16:54.000Z" });
    const route = decodePolyline(a.map?.summary_polyline);
    expect(route.length).toBeLessThanOrEqual(600); // downsampled
    expect(routePassesWithin(route, pts[1500], 10)).toBe(true);
  });

  it("falls back to the list summary when there's no FIT (no GPS, so no quests)", () => {
    const a = fitToActivity({ ...ref, sportType: 101, distanceM: 5000, durationS: 1500 }, {});
    expect(a).toMatchObject({ sport_type: "Run", distance: 5000, moving_time: 1500, map: { summary_polyline: null } });
  });
});

describe("COROS sync", () => {
  let db: DB;
  const connectedAt = new Date("2026-09-29T12:00:00Z");
  const ts = (iso: string) => Math.floor(Date.parse(iso) / 1000);

  beforeEach(async () => {
    db = await freshDb();
    await seedWishlist(db);
    await addGoal(db, { type: "single_run_distance", targetKm: 5 });
    await db.update(users).set({ corosTokensEnc: "x", corosConnectedAt: connectedAt });
  });

  function fakeSource(refs: CorosRunRef[]): CorosSource & { fetchRun: ReturnType<typeof vi.fn> } {
    return {
      listRuns: async () => refs,
      fetchRun: vi.fn(async (_u, ref: CorosRunRef) =>
        fitToActivity(ref, { sessions: [{ total_distance: ref.distanceM, total_timer_time: ref.durationS, start_time: new Date(ref.startTs * 1000) }] }),
      ),
    };
  }

  it("ignores runs from before you connected, then rewards new ones exactly once", async () => {
    const old = { labelId: "1", sportType: 100, startTs: ts("2026-09-20T12:00:00Z"), endTs: ts("2026-09-20T12:40:00Z"), distanceM: 8000, durationS: 2400 };
    const fresh = { labelId: "2", sportType: 100, startTs: ts("2026-09-29T14:00:00Z"), endTs: ts("2026-09-29T14:30:00Z"), distanceM: 5300, durationS: 1800 };
    const onRewardCreated = vi.fn(async () => {});

    const src1 = fakeSource([old]);
    const first = await syncCoros(db, { source: src1, onRewardCreated });
    expect(first.newRuns).toBe(0);
    expect(src1.fetchRun).not.toHaveBeenCalled();

    const src2 = fakeSource([old, fresh]);
    const second = await syncCoros(db, { source: src2, onRewardCreated });
    expect(second.newRuns).toBe(1);
    expect(second.outcomes[0].status).toBe("reward_created");
    expect(onRewardCreated).toHaveBeenCalledTimes(1);

    // Polling again (or two polls racing) never duplicates.
    const third = await syncCoros(db, { source: fakeSource([old, fresh]), onRewardCreated });
    expect(third.newRuns).toBe(0);
    expect(await db.select().from(activities)).toHaveLength(1);
    expect(await db.select().from(rewardEvents)).toHaveLength(1);
    const [a] = await db.select().from(activities);
    expect(a).toMatchObject({ source: "coros", externalId: "coros:2", stravaId: null });
  });

  it("does nothing when COROS isn't connected", async () => {
    await db.update(users).set({ corosTokensEnc: null });
    const src = fakeSource([]);
    expect(await syncCoros(db, { source: src })).toEqual({ checked: 0, newRuns: 0, outcomes: [] });
  });
});
