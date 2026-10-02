import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { DB } from "@/db";
import { challenges, goals, rewardEvents, spendLedger } from "@/db/schema";
import { runAgent } from "@/lib/agent";
import { challengeProgress, challengeWindow } from "@/lib/challenges";
import { processActivity, storeActivity } from "@/lib/pipeline";
import { MockProvider } from "@/lib/providers";
import { freshDb, seedWishlist, stravaRun } from "./helpers";
import { scriptedClaude, toolUse } from "./fake-claude";

const TZ = "America/Toronto";

describe("challenge windows", () => {
  const weekly = { startsOn: "2026-10-05", lengthDays: 7, repeats: true }; // a Monday

  it("finds the window containing a moment, in local time", () => {
    // Sunday 11:30 pm Toronto is still day 7 of the first window.
    const w = challengeWindow(weekly, new Date("2026-10-12T03:30:00Z"), TZ)!;
    expect(w).toMatchObject({ index: 0, startKey: "2026-10-05", endKey: "2026-10-12" });
    expect(w.start.toISOString()).toBe("2026-10-05T04:00:00.000Z");
    // Monday 00:30 local starts window #1.
    expect(challengeWindow(weekly, new Date("2026-10-12T04:30:00Z"), TZ)).toMatchObject({ index: 1, startKey: "2026-10-12" });
  });

  it("returns nothing before the start, or after a one-off challenge ends", () => {
    expect(challengeWindow(weekly, new Date("2026-10-04T12:00:00Z"), TZ)).toBeNull();
    expect(challengeWindow({ ...weekly, repeats: false }, new Date("2026-10-13T12:00:00Z"), TZ)).toBeNull();
  });
});

describe("5 / 10 / 20 km challenge", () => {
  let db: DB;
  let items: Awaited<ReturnType<typeof seedWishlist>>;
  let goalIds: Record<number, number>;

  beforeEach(async () => {
    db = await freshDb();
    items = await seedWishlist(db); // gels $12 small, bars $24.99 medium, vest $35 large
    const [c] = await db.insert(challenges).values({ name: "Weekly 20K", startsOn: "2026-10-05", lengthDays: 7, repeats: true }).returning();
    // 20 km is fixed to the protein bars (medium price) even though the milestone tier is small.
    const bars = items.find((i) => i.title === "Protein bars")!.id;
    const rows = await db
      .insert(goals)
      .values([
        { name: "5 km", type: "weekly_distance", targetKm: 5, rewardTier: "small", challengeId: c.id },
        { name: "10 km", type: "weekly_distance", targetKm: 10, rewardTier: "medium", challengeId: c.id },
        { name: "20 km", type: "weekly_distance", targetKm: 20, rewardTier: "small", challengeId: c.id, rewardItemId: bars },
      ])
      .returning();
    goalIds = Object.fromEntries(rows.map((r) => [r.targetKm!, r.id]));
  });

  async function run(km: number, iso: string) {
    const { activity } = await storeActivity(db, stravaRun({ distance: km * 1000, moving_time: km * 330, start_date: iso }), "strava");
    return processActivity(db, activity);
  }

  it("unlocks each milestone once as the week's total crosses it", async () => {
    expect((await run(3, "2026-10-05T12:00:00Z")).status).toBe("no_goal");
    const r2 = await run(3, "2026-10-06T12:00:00Z"); // 6 km → 5 km milestone
    expect(r2.status).toBe("reward_created");
    expect((await run(3, "2026-10-07T12:00:00Z")).status).toBe("no_goal"); // 9 km
    const r4 = await run(2, "2026-10-08T12:00:00Z"); // 11 km → 10 km milestone
    expect(r4.status).toBe("reward_created");

    const events = await db.select().from(rewardEvents);
    expect(events.map((e) => e.goalId).sort()).toEqual([goalIds[5], goalIds[10]].sort());

    const [p] = await challengeProgress(db, new Date("2026-10-08T20:00:00Z"), TZ);
    expect(p.totalM).toBe(11_000);
    expect(p.milestones.map((m) => [m.km, m.unlocked])).toEqual([
      [5, true],
      [10, true],
      [20, false],
    ]);
  });

  it("one big run can unlock several milestones at once", async () => {
    const r = await run(12, "2026-10-06T12:00:00Z");
    expect(r.status).toBe("reward_created");
    if (r.status !== "reward_created") return;
    expect(r.rewardEventIds).toHaveLength(2);
    const events = await db.select().from(rewardEvents);
    expect(events.map((e) => e.goalId).sort()).toEqual([goalIds[5], goalIds[10]].sort());
  });

  it("starts fresh the next week", async () => {
    await run(6, "2026-10-06T12:00:00Z"); // week 1: 5 km unlocked
    const r = await run(6, "2026-10-13T12:00:00Z"); // week 2: 5 km again
    expect(r.status).toBe("reward_created");
    expect(await db.select().from(rewardEvents)).toHaveLength(2);
  });

  it("a fixed milestone reward forces Claude to pick that item, even above the tier", async () => {
    const r = await run(21, "2026-10-06T12:00:00Z"); // 5, 10 and 20 km all at once
    if (r.status !== "reward_created") throw new Error(r.status);
    expect(r.rewardEventIds).toHaveLength(3);
    const [twenty] = await db.select().from(rewardEvents).where(eq(rewardEvents.goalId, goalIds[20]));
    const bars = items.find((i) => i.title === "Protein bars")!.id;
    const gels = items.find((i) => i.title === "Gels")!.id;

    const claude = scriptedClaude([
      [toolUse("choose_reward", { item_id: gels, message: "Gels!" })], // rejected: milestone is fixed
      [toolUse("choose_reward", { item_id: bars, message: "20 km week. Protein bars, earned." })],
    ]);
    const res = await runAgent(db, twenty.id, { createMessage: claude.createMessage, provider: new MockProvider() });
    expect(res).toMatchObject({ ok: true, itemId: bars });
  });

  it("spreads the budget across simultaneous unlocks", async () => {
    // $40/day cap: take $20 off first, so $20 is left for two unlocks.
    const { activity: earlier } = await storeActivity(db, stravaRun({ distance: 1000, start_date: "2026-10-01T12:00:00Z" }), "strava");
    const [ev] = await db.insert(rewardEvents).values({ activityId: earlier.id, status: "completed" }).returning();
    await db.insert(spendLedger).values({ amountCents: 40_00, rewardEventId: ev.id, kind: "settled" }); // today: $20 left of $60

    const r = await run(12, "2026-10-06T12:00:00Z");
    // 5 km (small: gels ≈ $13.56) fits; 10 km's cheapest (gels again) no longer fits in the remaining ~$6.
    const events = await db.select().from(rewardEvents).where(eq(rewardEvents.activityId, r.activityId!));
    const byGoal = Object.fromEntries(events.map((e) => [e.goalId!, e.status]));
    expect(byGoal[goalIds[5]]).toBe("pending_agent");
    expect(byGoal[goalIds[10]]).toBe("skipped_budget");
  });
});

describe("demo data", () => {
  it("deleting demo runs removes them and their rewards, keeps real runs", async () => {
    const { deleteDemoData } = await import("@/lib/demo");
    const db = await freshDb();
    await seedWishlist(db);
    const { addGoal } = await import("./helpers");
    await addGoal(db, { type: "single_run_distance", targetKm: 5 });
    const { activity: fake } = await storeActivity(db, { ...stravaRun({ distance: 6000 }), id: -1 }, "simulated");
    const { activity: real } = await storeActivity(db, stravaRun({ distance: 6000 }), "strava");
    await processActivity(db, fake);
    await processActivity(db, real);
    expect(await deleteDemoData(db)).toEqual({ runs: 1, rewards: 1, orders: 0 });
    const { activities } = await import("@/db/schema");
    expect((await db.select().from(activities)).map((a) => a.source)).toEqual(["strava"]);
    expect(await db.select().from(rewardEvents)).toHaveLength(1);
  });
});
