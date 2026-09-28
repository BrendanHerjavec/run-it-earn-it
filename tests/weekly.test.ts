import { beforeEach, describe, expect, it } from "vitest";
import type { DB } from "@/db";
import { rewardEvents } from "@/db/schema";
import { processActivity, storeActivity } from "@/lib/pipeline";
import { weeklyDistanceM } from "@/lib/stats";
import { startOfLocalWeek } from "@/lib/time";
import { addGoal, freshDb, seedWishlist, stravaRun } from "./helpers";

const TZ = "America/Toronto";
let db: DB;

beforeEach(async () => {
  db = await freshDb();
  await seedWishlist(db);
});

describe("week boundaries", () => {
  it("weeks start Monday 00:00 in the user's timezone", () => {
    // Sunday 11pm Toronto (EDT, UTC-4) = Monday 03:00 UTC: still the previous week locally.
    const sundayNight = new Date("2026-09-28T03:00:00Z");
    expect(startOfLocalWeek(sundayNight, TZ).toISOString()).toBe("2026-09-21T04:00:00.000Z");
    const mondayMorning = new Date("2026-09-28T05:00:00Z");
    expect(startOfLocalWeek(mondayMorning, TZ).toISOString()).toBe("2026-09-28T04:00:00.000Z");
  });

  it("handles the DST change in November (EDT → EST)", () => {
    // DST ends Sunday 2026-11-01. Monday 2026-11-02 local midnight is UTC-5.
    expect(startOfLocalWeek(new Date("2026-11-04T12:00:00Z"), TZ).toISOString()).toBe("2026-11-02T05:00:00.000Z");
  });
});

describe("weekly distance totals", () => {
  it("sums runs in the local week and excludes rides, flagged runs and last week", async () => {
    await storeActivity(db, stravaRun({ distance: 5000, start_date: "2026-09-21T12:00:00Z" }), "strava"); // Mon
    await storeActivity(db, stravaRun({ distance: 7000, sport_type: "TrailRun", start_date: "2026-09-23T12:00:00Z" }), "strava");
    await storeActivity(db, stravaRun({ distance: 30000, sport_type: "Ride", start_date: "2026-09-23T13:00:00Z" }), "strava");
    await storeActivity(db, stravaRun({ distance: 10000, moving_time: 1200, start_date: "2026-09-24T12:00:00Z" }), "strava"); // 30 km/h, flagged
    await storeActivity(db, stravaRun({ distance: 9000, start_date: "2026-09-20T12:00:00Z" }), "strava"); // previous Sunday

    const total = await weeklyDistanceM(db, new Date("2026-09-26T12:00:00Z"), TZ);
    expect(total).toBe(12000);
  });

  it("awards the weekly goal once, on the run that crosses the target", async () => {
    const goal = await addGoal(db, { type: "weekly_distance", targetKm: 15, name: "15 km week" });
    const runs = [
      { distance: 6000, start_date: "2026-09-21T12:00:00Z" },
      { distance: 6000, start_date: "2026-09-22T12:00:00Z" },
      { distance: 6000, start_date: "2026-09-23T12:00:00Z" }, // crosses 15 km here
      { distance: 6000, start_date: "2026-09-24T12:00:00Z" },
    ];
    const statuses = [];
    for (const r of runs) {
      const { activity } = await storeActivity(db, stravaRun(r), "strava");
      statuses.push((await processActivity(db, activity)).status);
    }
    expect(statuses).toEqual(["no_goal", "no_goal", "reward_created", "no_goal"]);
    const events = await db.select().from(rewardEvents);
    expect(events).toHaveLength(1);
    expect(events[0].goalId).toBe(goal.id);
  });
});
