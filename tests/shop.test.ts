import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DB } from "@/db";
import { challenges, eventLog, goals, rewardEvents, wishlistItems } from "@/db/schema";
import { runAgent } from "@/lib/agent";
import { basketLines, dueBaskets } from "@/lib/basket";
import { resetConfigCache } from "@/lib/config";
import { processActivity, storeActivity } from "@/lib/pipeline";
import { MockProvider } from "@/lib/providers";
import { runRewardAgent } from "@/lib/rewards";
import { shopCatalog } from "@/lib/shop";
import { freshDb, stravaRun } from "./helpers";
import { scriptedClaude, toolUse } from "./fake-claude";

const TZ = "America/Toronto";
const SHOP = "https://eightouncecoffee.ca/collections/funky";

// A slice of Eight Ounce's "Funky" collection, as its products.json returns it.
const product = (handle: string, title: string, price: string, tags: string[], available = true) => ({
  handle,
  title,
  vendor: "Roaster",
  body_html: `<p>Tasting Notes: ${title} vibes.</p><p>Long story.</p>`,
  tags,
  variants: [{ id: handle.length, price, available }],
});
const FILTER_BEAN = ["meth_Filter", "form_Roasted Whole Bean", "proc_Anaerobic", "size_250g"];
const SHELF = [
  product("standard", "Standard", "22.00", FILTER_BEAN),
  product("strawberry", "Strawberry", "28.00", FILTER_BEAN),
  product("guava", "Guava", "37.00", ["meth_Filter or Espresso", "form_Roasted Whole Bean"]),
  product("lychee", "Lychee", "36.00", FILTER_BEAN, false), // sold out
  product("geisha", "Geisha", "51.00", FILTER_BEAN),
  product("espresso", "Espresso", "35.00", ["meth_Espresso", "form_Roasted Whole Bean"]),
  product("sachets", "Sachets", "18.00", ["meth_Filter", "form_Sachets"]),
];
const fakeFetch = (async (url: string) => {
  const page = Number(new URL(url).searchParams.get("page"));
  return new Response(JSON.stringify({ products: page === 1 ? SHELF : [] }));
}) as unknown as typeof fetch;

let db: DB;
let clock: number;
const deps = () => ({ provider: new MockProvider(() => clock), fetch: fakeFetch });

beforeEach(async () => {
  Object.assign(process.env, { MAX_ORDER_CAD: "150", MAX_DAILY_CAD: "150", MAX_WEEKLY_CAD: "150" });
  resetConfigCache();
  db = await freshDb();
  const [c] = await db
    .insert(challenges)
    .values({
      name: "Funky week",
      startsOn: "2026-10-05",
      lengthDays: 7,
      repeats: true,
      basketCheckout: true,
      shopUrl: SHOP,
      shopTag: "meth_Filter, whole bean",
      freeShippingCents: 75_00,
    })
    .returning();
  await db
    .insert(goals)
    .values([
      { name: "5 km", type: "weekly_distance", targetKm: 5, maxPriceCents: 30_00, challengeId: c.id },
      { name: "10 km", type: "weekly_distance", targetKm: 10, maxPriceCents: 40_00, challengeId: c.id },
      { name: "20 km", type: "weekly_distance", targetKm: 20, maxPriceCents: 55_00, challengeId: c.id },
    ]);
  clock = Date.parse("2026-10-12T15:00:00Z");
});

afterEach(() => {
  Object.assign(process.env, { MAX_ORDER_CAD: "40", MAX_DAILY_CAD: "60", MAX_WEEKLY_CAD: "100" });
  resetConfigCache();
});

async function run(km: number, iso: string) {
  const { activity } = await storeActivity(db, stravaRun({ distance: km * 1000, moving_time: km * 330, start_date: iso }), "strava");
  const out = await processActivity(db, activity, { fetch: fakeFetch });
  if (out.status !== "reward_created") throw new Error(`${out.status}: ${out.reason}`);
  return out.rewardEventIds;
}

const pick = (handle: string, message = "Nice run!") => scriptedClaude([[toolUse("choose_reward", { product: handle, message })]]).createMessage;

describe("shop challenges", () => {
  it("reads in-stock products matching every tag, with tasting notes", async () => {
    const shelf = await shopCatalog(SHOP, "meth_Filter, whole bean", fakeFetch);
    expect(shelf.map((p) => p.handle)).toEqual(["standard", "strawberry", "guava", "geisha"]);
    expect(shelf[1]).toMatchObject({
      url: "https://eightouncecoffee.ca/products/strawberry",
      title: "Roaster - Strawberry",
      priceCents: 28_00,
      notes: "Tasting: Strawberry vibes · Anaerobic · 250g",
    });
  });

  it("Claude browses the store and picks by handle; the pick is saved off the wishlist", async () => {
    const [id] = await run(6, "2026-10-06T12:00:00Z");
    const claude = scriptedClaude([
      [toolUse("browse_store", {})],
      [toolUse("choose_reward", { product: "strawberry", message: "Strawberry for a 6K!" })],
    ]);
    const r = await runAgent(db, id, { ...deps(), createMessage: claude.createMessage });
    expect(r).toMatchObject({ ok: true, quotedTotalCents: 28_00 });

    expect(claude.requests[0].tools!.map((t) => ("name" in t ? t.name : ""))).toEqual(["get_run_summary", "browse_store", "get_budget_status", "choose_reward"]);
    const shelf = JSON.parse(String((claude.requests[1].messages.at(-1)!.content as { content: string }[])[0].content));
    expect(shelf.eligible.map((p: { handle: string }) => p.handle)).toEqual(["strawberry", "standard"]); // under $30, priciest first
    expect(shelf.in_stock_total).toBe(4);

    const [item] = await db.select().from(wishlistItems);
    expect(item).toMatchObject({ source: "shop", productUrl: "https://eightouncecoffee.ca/products/strawberry", expectedPriceCents: 28_00 });
  });

  it("each milestone is fancier than the last, and never repeats a bag", async () => {
    await run(6, "2026-10-06T12:00:00Z").then(([id]) => runRewardAgent(db, id, { ...deps(), createMessage: pick("strawberry") }));
    const [ten, twenty] = await run(15, "2026-10-08T12:00:00Z");
    // 10 km: must beat the 5 km milestone's $30 limit, so the $28 bag (already picked anyway) is out.
    const r10 = await runAgent(db, ten, {
      ...deps(),
      createMessage: scriptedClaude([
        [toolUse("choose_reward", { product: "standard", message: "x" })],
        [toolUse("choose_reward", { product: "guava", message: "Guava for 10!" })],
      ]).createMessage,
    });
    expect(r10).toMatchObject({ ok: true, quotedTotalCents: 37_00 });
    const errors = (await db.select().from(eventLog).where(eq(eventLog.rewardEventId, ten))).filter((l) => l.kind === "agent.tool_error");
    expect(errors[0].message).toMatch(/fancier than the last one: pick something over \$30\.00/);

    await db.update(rewardEvents).set({ status: "in_basket", chosenItemId: (await db.select().from(wishlistItems))[1].id }).where(eq(rewardEvents.id, ten));
    const r20 = await runAgent(db, twenty, { ...deps(), createMessage: scriptedClaude([[toolUse("choose_reward", { product: "guava", message: "x" })], []]).createMessage });
    expect(r20.ok).toBe(false); // $37 is under the $40 floor, and guava is already in the basket
    const again = (await db.select().from(eventLog).where(eq(eventLog.rewardEventId, twenty))).find((l) => l.kind === "agent.tool_error");
    expect(again?.message).toMatch(/already picked/);
  });

  it("a basket under free shipping rolls into next week instead of ordering", async () => {
    await run(6, "2026-10-06T12:00:00Z").then(([id]) => runRewardAgent(db, id, { ...deps(), createMessage: pick("strawberry") }));
    // Week 1 ends with $28 in the basket: not ordered.
    expect(await dueBaskets(db, new Date("2026-10-13T12:00:00Z"), TZ)).toEqual([]);

    // Week 2: 15 km unlocks 5 and 10 km; the basket carries last week's bag too.
    const [five, ten] = await run(15, "2026-10-14T12:00:00Z");
    await runRewardAgent(db, five, { ...deps(), createMessage: pick("standard") });
    await runRewardAgent(db, ten, { ...deps(), createMessage: pick("guava") });
    const lines = await basketLines(db, 1, "2026-10-12", TZ);
    expect(lines.map((l) => l.item.expectedPriceCents)).toEqual([28_00, 22_00, 37_00]); // $87 ≥ $75

    expect(await dueBaskets(db, new Date("2026-10-16T12:00:00Z"), TZ)).toEqual([]); // week 2 not over yet
    expect(await dueBaskets(db, new Date("2026-10-20T12:00:00Z"), TZ)).toEqual([{ challengeId: 1, startKey: "2026-10-12" }]);
  });

  it("Claude sees how far the basket is from free shipping", async () => {
    await run(6, "2026-10-06T12:00:00Z").then(([id]) => runRewardAgent(db, id, { ...deps(), createMessage: pick("strawberry") }));
    const [ten] = await run(5, "2026-10-07T12:00:00Z");
    const claude = scriptedClaude([[toolUse("get_budget_status", {})], [toolUse("choose_reward", { product: "guava", message: "Free shipping unlocked!" })]]);
    await runAgent(db, ten, { ...deps(), createMessage: claude.createMessage });
    const budget = JSON.parse(String((claude.requests[1].messages.at(-1)!.content as { content: string }[])[0].content));
    expect(budget).toMatchObject({ basket_subtotal: "$28.00", free_shipping_at: "$75.00", still_needed_for_free_shipping: "$47.00" });
  });
});
