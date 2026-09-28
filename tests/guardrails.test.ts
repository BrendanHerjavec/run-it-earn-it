import { beforeEach, describe, expect, it } from "vitest";
import type { DB } from "@/db";
import { activities, rewardEvents, settings, spendLedger } from "@/db/schema";
import { resetConfigCache } from "@/lib/config";
import { processActivity, storeActivity } from "@/lib/pipeline";
import { sanityCheck, pickGoal } from "@/lib/rules";
import { getEffectiveSettings } from "@/lib/settings";
import { budgetStatus } from "@/lib/stats";
import { addGoal, freshDb, seedWishlist, stravaRun } from "./helpers";

let db: DB;

beforeEach(async () => {
  db = await freshDb();
  await seedWishlist(db);
});

describe("speed sanity check", () => {
  it("accepts a normal run and rejects non-runs without flagging", () => {
    expect(sanityCheck({ sportType: "Run", averageSpeedMps: 3.1 }, 20).ok).toBe(true);
    expect(sanityCheck({ sportType: "TrailRun", averageSpeedMps: 2.5 }, 20).ok).toBe(true);
    const ride = sanityCheck({ sportType: "Ride", averageSpeedMps: 7 }, 20);
    expect(ride).toMatchObject({ ok: false, flag: false });
  });

  it("flags a 'run' faster than 20 km/h and never rewards it", async () => {
    await addGoal(db, { type: "single_run_distance", targetKm: 5 });
    // 10 km in 25 min = 24 km/h
    const { activity } = await storeActivity(db, stravaRun({ distance: 10000, moving_time: 1500 }), "strava");
    expect(activity.flagged).toBe(true);
    expect(activity.flagReason).toMatch(/24\.0 km\/h/);
    const out = await processActivity(db, activity);
    expect(out.status).toBe("flagged");
    expect(await db.select().from(rewardEvents)).toHaveLength(0);
  });

  it("ignores rides even when the distance goal is met", async () => {
    await addGoal(db, { type: "single_run_distance", targetKm: 5 });
    const { activity } = await storeActivity(db, stravaRun({ sport_type: "Ride", distance: 40000, moving_time: 5400 }), "strava");
    expect((await processActivity(db, activity)).status).toBe("ignored");
  });
});

describe("cap enforcement", () => {
  it("settings can tighten env caps but never loosen them", async () => {
    await db.insert(settings).values({ id: 1, maxOrderCents: 500_00, maxDailyCents: 25_00 }).onConflictDoUpdate({
      target: settings.id,
      set: { maxOrderCents: 500_00, maxDailyCents: 25_00 },
    });
    const s = await getEffectiveSettings(db);
    expect(s.maxOrderCents).toBe(40_00); // env ceiling wins
    expect(s.maxDailyCents).toBe(25_00); // tighter setting wins
    expect(s.autoBuy).toBe(false); // env AUTO_BUY=false overrides any toggle
    expect(s.purchasesEnabled).toBe(false);
  });

  it("auto-buy needs both the env flag and the settings toggle", async () => {
    await db.insert(settings).values({ id: 1, autoBuy: true }).onConflictDoUpdate({ target: settings.id, set: { autoBuy: true } });
    expect((await getEffectiveSettings(db)).autoBuy).toBe(false);
    process.env.AUTO_BUY = "true";
    resetConfigCache();
    try {
      expect((await getEffectiveSettings(db)).autoBuy).toBe(true);
    } finally {
      process.env.AUTO_BUY = "false";
      resetConfigCache();
    }
  });

  it("remaining budget is the smallest of per-order, daily and weekly room", async () => {
    const s = await getEffectiveSettings(db);
    const { activity } = await storeActivity(db, stravaRun(), "strava");
    const [ev] = await db.insert(rewardEvents).values({ activityId: activity.id, status: "completed" }).returning();
    await db.insert(spendLedger).values({ amountCents: 45_00, rewardEventId: ev.id, kind: "settled" });
    const b = await budgetStatus(db, s, new Date(), "America/Toronto");
    expect(b.remainingDailyCents).toBe(15_00); // 60 - 45
    expect(b.remainingWeeklyCents).toBe(55_00); // 100 - 45
    expect(b.availableForNextOrderCents).toBe(15_00);
  });

  it("released (failed) checkouts don't count against the budget", async () => {
    const s = await getEffectiveSettings(db);
    const { activity } = await storeActivity(db, stravaRun(), "strava");
    const [ev] = await db.insert(rewardEvents).values({ activityId: activity.id, status: "failed" }).returning();
    await db.insert(spendLedger).values({ amountCents: 30_00, rewardEventId: ev.id, kind: "released" });
    expect((await budgetStatus(db, s, new Date(), "America/Toronto")).availableForNextOrderCents).toBe(40_00);
  });

  it("marks the reward skipped_budget when nothing on the wishlist fits the remaining budget", async () => {
    await addGoal(db, { type: "single_run_distance", targetKm: 5, rewardTier: "medium" });
    const { activity: spent } = await storeActivity(db, stravaRun(), "strava");
    const [ev] = await db.insert(rewardEvents).values({ activityId: spent.id, status: "completed" }).returning();
    await db.insert(spendLedger).values({ amountCents: 55_00, rewardEventId: ev.id, kind: "settled" }); // $5 left today

    const { activity } = await storeActivity(db, stravaRun(), "strava");
    const out = await processActivity(db, activity);
    expect(out.status).toBe("skipped_budget");
    expect(out.reason).toMatch(/5\.00 CAD available/);
  });
});

describe("goal selection", () => {
  it("one reward per activity: highest tier wins, quests win ties", async () => {
    const small = await addGoal(db, { type: "single_run_distance", targetKm: 3, rewardTier: "small" });
    const medium = await addGoal(db, { type: "single_run_distance", targetKm: 5, rewardTier: "medium" });
    const questMedium = await addGoal(db, { type: "quest", lat: 43.65, lng: -79.38, radiusM: 75, rewardTier: "medium" });
    const hit = pickGoal([
      { goal: small, detail: "" },
      { goal: medium, detail: "" },
      { goal: questMedium, detail: "" },
    ]);
    expect(hit?.goal.id).toBe(questMedium.id);
    expect(await db.select().from(activities)).toHaveLength(0);
  });
});
