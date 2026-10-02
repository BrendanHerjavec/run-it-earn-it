import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DB } from "@/db";
import { challenges, goals, orders, rewardEvents, spendLedger, wishlistItems } from "@/db/schema";
import { runAgent } from "@/lib/agent";
import { basketLines, cancelPendingOrder, createBasketOrder, dueBaskets, runBasketOrder } from "@/lib/basket";
import { resetConfigCache } from "@/lib/config";
import { processActivity, storeActivity } from "@/lib/pipeline";
import { MockProvider } from "@/lib/providers";
import { buildCartLink } from "@/lib/providers/cart";
import { runRewardAgent } from "@/lib/rewards";
import { freshDb, stravaRun } from "./helpers";
import { scriptedClaude, toolUse } from "./fake-claude";

const TZ = "America/Toronto";
let db: DB;
let bag: Record<string, number>;
let milestone: Record<number, number>;
let clock: number;
const provider = () => new MockProvider(() => clock);

beforeEach(async () => {
  // The runner's caps: one order of up to $120 a week.
  Object.assign(process.env, { MAX_ORDER_CAD: "120", MAX_DAILY_CAD: "120", MAX_WEEKLY_CAD: "120" });
  resetConfigCache();
  db = await freshDb();
  const items = await db
    .insert(wishlistItems)
    .values([
      { title: "FUNK Downtempo Decaf", productUrl: "https://eightouncecoffee.ca/products/funk-downtempo-decaf", expectedPriceCents: 22_50, tier: "medium" },
      { title: "FUNK Going the Distance", productUrl: "https://eightouncecoffee.ca/products/funk-going-the-distance", expectedPriceCents: 29_50, tier: "medium" },
      { title: "FUNK Drop the Pressure", productUrl: "https://eightouncecoffee.ca/products/funk-drop-the-pressure", expectedPriceCents: 37_50, tier: "large" },
      { title: "Fancy Geisha", productUrl: "https://eightouncecoffee.ca/products/geisha", expectedPriceCents: 55_00, tier: "large" },
    ])
    .returning();
  bag = Object.fromEntries(items.map((i) => [i.title.split(" ").slice(-1)[0], i.id])); // Decaf, Distance, Pressure, Geisha
  const [c] = await db.insert(challenges).values({ name: "Weekly 20K", startsOn: "2026-10-05", lengthDays: 7, repeats: true, basketCheckout: true }).returning();
  const ms = await db
    .insert(goals)
    .values([
      { name: "5 km", type: "weekly_distance", targetKm: 5, maxPriceCents: 25_00, challengeId: c.id },
      { name: "10 km", type: "weekly_distance", targetKm: 10, maxPriceCents: 32_00, challengeId: c.id },
      { name: "20 km", type: "weekly_distance", targetKm: 20, maxPriceCents: 40_00, challengeId: c.id },
    ])
    .returning();
  milestone = Object.fromEntries(ms.map((m) => [m.targetKm!, m.id]));
  clock = Date.parse("2026-10-12T15:00:00Z");
});

afterEach(() => {
  Object.assign(process.env, { MAX_ORDER_CAD: "40", MAX_DAILY_CAD: "60", MAX_WEEKLY_CAD: "100" });
  resetConfigCache();
});

async function runAndPick(km: number, iso: string, picks: { item: number; msg: string }[]) {
  const { activity } = await storeActivity(db, stravaRun({ distance: km * 1000, moving_time: km * 330, start_date: iso }), "strava");
  const out = await processActivity(db, activity);
  if (out.status !== "reward_created") throw new Error(out.status);
  for (const [i, id] of out.rewardEventIds.entries()) {
    const p = picks[i];
    await runRewardAgent(db, id, { provider: provider(), createMessage: scriptedClaude([[toolUse("choose_reward", { item_id: p.item, message: p.msg })]]).createMessage });
  }
  return out.rewardEventIds;
}

describe("basket challenge", () => {
  it("milestone picks go into the basket instead of checking out", async () => {
    const [id] = await runAndPick(6, "2026-10-06T12:00:00Z", [{ item: bag.Decaf, msg: "First 5K: decaf to start." }]);
    const [ev] = await db.select().from(rewardEvents).where(eq(rewardEvents.id, id));
    expect(ev.status).toBe("in_basket");
    expect(ev.provider).toBeNull();
    expect(await db.select().from(spendLedger)).toHaveLength(0); // nothing spent yet
  });

  it("each milestone has its own price limit: fancier the further you go", async () => {
    const [id5] = await runAndPick(6, "2026-10-06T12:00:00Z", [{ item: bag.Decaf, msg: "5K" }]);
    expect((await db.select().from(rewardEvents).where(eq(rewardEvents.id, id5)))[0].status).toBe("in_basket");

    // At 10 km, the $37.50 bag is over the $32 limit; the $29.50 bag is fine.
    const { activity } = await storeActivity(db, stravaRun({ distance: 5000, start_date: "2026-10-07T12:00:00Z" }), "strava");
    const out = await processActivity(db, activity);
    if (out.status !== "reward_created") throw new Error(out.status);
    const claude = scriptedClaude([
      [toolUse("choose_reward", { item_id: bag.Pressure, message: "Too fancy" })],
      [toolUse("choose_reward", { item_id: bag.Distance, message: "Going the Distance, fitting." })],
    ]);
    const r = await runAgent(db, out.rewardEventId, { provider: provider(), createMessage: claude.createMessage });
    expect(r).toMatchObject({ ok: true, itemId: bag.Distance });

    // The $55 bag never fits, even at 20 km ($40 limit).
    const g = await runAgent(db, out.rewardEventId, {
      provider: provider(),
      createMessage: scriptedClaude([[toolUse("choose_reward", { item_id: bag.Geisha, message: "x" })], []]).createMessage,
    });
    expect(g.ok).toBe(false);
  });

  it("the whole basket must fit the order cap", async () => {
    Object.assign(process.env, { MAX_ORDER_CAD: "55", MAX_DAILY_CAD: "120", MAX_WEEKLY_CAD: "120" });
    resetConfigCache();
    await runAndPick(6, "2026-10-06T12:00:00Z", [{ item: bag.Decaf, msg: "5K" }]); // $22.50 in the basket
    const { activity } = await storeActivity(db, stravaRun({ distance: 15000, moving_time: 5000, start_date: "2026-10-07T12:00:00Z" }), "strava");
    const out = await processActivity(db, activity); // 10 and 20 km together
    if (out.status !== "reward_created") throw new Error(out.status);
    const twenty = (await db.select().from(rewardEvents).where(eq(rewardEvents.goalId, milestone[20])))[0];
    const r = await runAgent(db, twenty.id, {
      provider: provider(),
      createMessage: scriptedClaude([[toolUse("choose_reward", { item_id: bag.Pressure, message: "x" })], []]).createMessage,
    });
    expect(r.ok).toBe(false); // $22.50 + $37.50 > $55
  });

  it("one combined order for the week: 3 bags, one checkout, one ledger entry", async () => {
    await runAndPick(6, "2026-10-06T12:00:00Z", [{ item: bag.Decaf, msg: "5K" }]);
    await runAndPick(15, "2026-10-09T12:00:00Z", [
      { item: bag.Distance, msg: "10K" },
      { item: bag.Pressure, msg: "20K!" },
    ]);
    const lines = await basketLines(db, 1, "2026-10-05", TZ);
    expect(lines.map((l) => l.milestoneKm)).toEqual([5, 10, 20]);

    const orderId = (await createBasketOrder(db, 1, "2026-10-05"))!;
    expect(orderId).toBeTruthy();
    expect(await createBasketOrder(db, 1, "2026-10-05")).toBeNull(); // one order per window

    await runBasketOrder(db, orderId, { provider: provider(), sleep: async (ms) => void (clock += ms * 10 + 5000) });
    const [o] = await db.select().from(orders).where(eq(orders.id, orderId));
    const subtotal = 22_50 + 29_50 + 37_50;
    expect(o.status).toBe("completed");
    expect(o.totalChargedCents).toBe(subtotal); // $89.50
    const ledger = await db.select().from(spendLedger);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ orderId, kind: "settled", amountCents: o.totalChargedCents });
    const evs = await db.select().from(rewardEvents);
    expect(evs.every((e) => e.status === "completed" && e.orderId === orderId)).toBe(true);
  });

  it("Cancel during the countdown keeps the bags in the basket", async () => {
    await runAndPick(6, "2026-10-06T12:00:00Z", [{ item: bag.Decaf, msg: "5K" }]);
    const orderId = (await createBasketOrder(db, 1, "2026-10-05"))!;
    expect(await cancelPendingOrder(db, orderId)).toBe(true);
    await runBasketOrder(db, orderId, { provider: provider(), sleep: async () => {} }); // no-op: order is gone
    expect(await db.select().from(orders)).toHaveLength(0);
    expect((await basketLines(db, 1, "2026-10-05", TZ)).length).toBe(1);
    expect(await createBasketOrder(db, 1, "2026-10-05")).toBeTruthy(); // can order again later
  });

  it("baskets are due once their week has ended", async () => {
    await runAndPick(6, "2026-10-06T12:00:00Z", [{ item: bag.Decaf, msg: "5K" }]);
    expect(await dueBaskets(db, new Date("2026-10-10T12:00:00Z"), TZ)).toEqual([]); // still this week
    expect(await dueBaskets(db, new Date("2026-10-12T12:00:00Z"), TZ)).toEqual([{ challengeId: 1, startKey: "2026-10-05" }]);
  });

  it("a multi-bag Shopify basket becomes one cart link", async () => {
    const products: Record<string, unknown> = {
      "funk-downtempo-decaf": { title: "Downtempo", handle: "funk-downtempo-decaf", variants: [{ id: 11, title: "Default Title", available: true, price: 2250 }] },
      "funk-drop-the-pressure": { title: "Drop", handle: "funk-drop-the-pressure", variants: [{ id: 33, title: "Default Title", available: true, price: 3750 }] },
    };
    const fakeFetch = (async (url: string) => {
      const handle = String(url).match(/products\/([^/.]+)\.js/)?.[1] ?? "";
      return new Response(JSON.stringify(products[handle] ?? {}), { status: products[handle] ? 200 : 404 });
    }) as unknown as typeof fetch;
    const [decaf, pressure] = await db.select().from(wishlistItems).where(eq(wishlistItems.tier, "medium")).limit(1)
      .then(async (m) => [m[0], (await db.select().from(wishlistItems).where(eq(wishlistItems.id, bag.Pressure)))[0]]);
    const link = await buildCartLink(
      [
        { item: decaf, qty: 2 },
        { item: pressure, qty: 1 },
      ],
      { name: "Test Runner", email: "", phone: "", addressLine1: "", addressLine2: "", city: "", province: "ON", postalCode: "M5V 2T6", country: "CA" },
      fakeFetch,
    );
    expect(link.kind).toBe("shopify_checkout");
    expect(new URL(link.url).pathname).toBe("/cart/11:2,33:1");
    expect(link.itemCents).toBe(2250 * 2 + 3750);
  });
});

describe("demo cleanup with baskets", () => {
  it("deleting demo runs also removes a demo-only basket order, freeing the week", async () => {
    const { deleteDemoData } = await import("@/lib/demo");
    const { activity } = await storeActivity(db, { ...stravaRun({ distance: 6000, start_date: "2026-10-06T12:00:00Z" }), id: -99 }, "simulated");
    const out = await processActivity(db, activity);
    if (out.status !== "reward_created") throw new Error(out.status);
    await runRewardAgent(db, out.rewardEventId, { provider: provider(), createMessage: scriptedClaude([[toolUse("choose_reward", { item_id: bag.Decaf, message: "5K" })]]).createMessage });
    const orderId = (await createBasketOrder(db, 1, "2026-10-05"))!;
    await runBasketOrder(db, orderId, { provider: provider(), sleep: async (ms) => void (clock += ms * 10 + 5000) });

    expect(await deleteDemoData(db)).toEqual({ runs: 1, rewards: 1, orders: 1 });
    expect(await db.select().from(orders)).toHaveLength(0);
    expect(await db.select().from(spendLedger)).toHaveLength(0);
  });
});

describe("fancier the further you go", () => {
  it("a later milestone must beat the previous milestone's price limit", async () => {
    const { activity } = await storeActivity(db, stravaRun({ distance: 21000, moving_time: 7000, start_date: "2026-10-06T12:00:00Z" }), "strava");
    const out = await processActivity(db, activity);
    if (out.status !== "reward_created") throw new Error(out.status);
    const twenty = (await db.select().from(rewardEvents).where(eq(rewardEvents.goalId, milestone[20])))[0];
    const claude = scriptedClaude([
      [toolUse("choose_reward", { item_id: bag.Decaf, message: "cheap" })], // $22.50 ≤ $32 floor: rejected
      [toolUse("choose_reward", { item_id: bag.Pressure, message: "20K: the fancy one." })], // $37.50: ok
    ]);
    const r = await runAgent(db, twenty.id, { provider: provider(), createMessage: claude.createMessage });
    expect(r).toMatchObject({ ok: true, itemId: bag.Pressure });
  });
});

describe("milestones in the basket count as unlocked", () => {
  it("a milestone already in this week's basket isn't unlocked again by a later-processed run", async () => {
    await runAndPick(6, "2026-10-08T12:00:00Z", [{ item: bag.Decaf, msg: "5K" }]); // 5 km → basket
    // A long run that started earlier in the week but synced later (re-crosses 5 km on its own).
    const { activity } = await storeActivity(db, stravaRun({ distance: 12000, moving_time: 4000, start_date: "2026-10-06T12:00:00Z" }), "strava");
    const out = await processActivity(db, activity);
    if (out.status !== "reward_created") throw new Error(out.status);
    const goalsHit = (await db.select().from(rewardEvents).where(eq(rewardEvents.activityId, activity.id))).map((e) => e.goalId);
    expect(goalsHit).toEqual([milestone[10]]); // 10 km only, not 5 km again

    const { challengeProgress } = await import("@/lib/challenges");
    const [p] = await challengeProgress(db, new Date("2026-10-09T12:00:00Z"), TZ);
    expect(p.milestones.find((m) => m.km === 5)?.unlocked).toBe(true);
  });
});
