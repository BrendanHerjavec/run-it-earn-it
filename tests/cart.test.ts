import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { DB } from "@/db";
import { rewardEvents, spendLedger, type WishlistItem } from "@/db/schema";
import { processActivity, storeActivity } from "@/lib/pipeline";
import { amazonAsin, buildCartLink, CartLinkProvider, pickVariant, shopifyPermalink } from "@/lib/providers/cart";
import type { Buyer } from "@/lib/providers";
import { approveReward, confirmPurchase, runCheckoutLoop, runRewardAgent } from "@/lib/rewards";
import { addGoal, freshDb, seedWishlist, stravaRun } from "./helpers";
import { scriptedClaude, toolUse } from "./fake-claude";

const buyer: Buyer = {
  name: "Test Runner",
  email: "runner@example.com",
  phone: "",
  addressLine1: "1 King St W",
  addressLine2: "",
  city: "Toronto",
  province: "ON",
  postalCode: "M5V 2T6",
  country: "CA",
};

const SOCKS = {
  title: "Run Sock",
  handle: "run-sock",
  variants: [
    { id: 111, title: "S / Black", available: true, price: 1800, options: ["S", "Black"] },
    { id: 222, title: "L / Black", available: true, price: 1800, options: ["L", "Black"] },
    { id: 333, title: "L / White", available: false, price: 1800, options: ["L", "White"] },
  ],
};

const item = (over: Partial<WishlistItem>) =>
  ({ id: 1, title: "Socks", productUrl: "https://shop.runners.ca/products/run-sock", expectedPriceCents: 19_99, tier: "small", notes: "", active: true, ...over }) as WishlistItem;

const fakeFetch = (body: unknown, ok = true) => (async () => new Response(JSON.stringify(body), { status: ok ? 200 : 404 })) as typeof fetch;

describe("cart links", () => {
  it("picks the Shopify variant from the notes, the URL, or the only option", () => {
    expect(pickVariant(SOCKS, "https://x.ca/products/run-sock", "Size: L, colour black")?.id).toBe(222);
    expect(pickVariant(SOCKS, "https://x.ca/products/run-sock?variant=111", "Size L")?.id).toBe(111);
    expect(pickVariant(SOCKS, "https://x.ca/products/run-sock", "Size L")?.id).toBe(222); // in-stock L wins the tie
    expect(pickVariant(SOCKS, "https://x.ca/products/run-sock", "")).toBeNull(); // ambiguous
    expect(pickVariant({ ...SOCKS, variants: [SOCKS.variants[0]] }, "https://x.ca/products/run-sock", "")?.id).toBe(111);
  });

  it("builds a Shopify cart permalink with your address prefilled", () => {
    const url = new URL(shopifyPermalink("https://shop.runners.ca", 222, buyer));
    expect(url.pathname).toBe("/cart/222:1");
    expect(url.searchParams.get("checkout[email]")).toBe("runner@example.com");
    expect(url.searchParams.get("checkout[shipping_address][first_name]")).toBe("Test");
    expect(url.searchParams.get("checkout[shipping_address][last_name]")).toBe("Runner");
    expect(url.searchParams.get("checkout[shipping_address][province]")).toBe("ON");
    expect(url.searchParams.get("checkout[shipping_address][country]")).toBe("Canada");
    expect(url.searchParams.get("checkout[shipping_address][zip]")).toBe("M5V 2T6");
  });

  it("uses live Shopify price and stock", async () => {
    const link = await buildCartLink(item({ notes: "Size L black" }), buyer, fakeFetch(SOCKS));
    expect(link).toMatchObject({ kind: "shopify_checkout", itemCents: 1800, available: true });
    expect(link.url).toContain("/cart/222:1?");
    const out = await buildCartLink(item({ notes: "L white" }), buyer, fakeFetch(SOCKS));
    expect(out.available).toBe(false);
  });

  it("uses Amazon's official add-to-cart URL", async () => {
    expect(amazonAsin("https://www.amazon.ca/Some-Name/dp/B0ABCDEF12/ref=x")).toBe("B0ABCDEF12");
    expect(amazonAsin("https://amazon.ca/gp/product/b0abcdef12")).toBe("B0ABCDEF12");
    const link = await buildCartLink(item({ productUrl: "https://amazon.ca/dp/B0ABCDEF12" }), buyer, fakeFetch({}, false));
    expect(link).toMatchObject({ kind: "amazon_cart", url: "https://www.amazon.ca/gp/aws/cart/add.html?ASIN.1=B0ABCDEF12&Quantity.1=1" });
  });

  it("falls back to the product page for other stores or ambiguous options", async () => {
    expect((await buildCartLink(item({ productUrl: "https://www.example.ca/p/123" }), buyer, fakeFetch({}, false))).kind).toBe("product_page");
    expect((await buildCartLink(item({ notes: "" }), buyer, fakeFetch(SOCKS))).kind).toBe("product_page");
    expect((await buildCartLink(item({}), buyer, (async () => new Response("<html>", { status: 200 })) as typeof fetch)).kind).toBe("product_page");
  });
});

describe("cart checkout end to end", () => {
  let db: DB;
  let opened: string[];
  let provider: CartLinkProvider;
  let id: number;

  beforeEach(async () => {
    db = await freshDb();
    const items = await seedWishlist(db);
    await addGoal(db, { type: "single_run_distance", targetKm: 5, rewardTier: "medium" });
    opened = [];
    provider = new CartLinkProvider({ fetch: fakeFetch({}, false), open: (u) => opened.push(u) });
    const { activity } = await storeActivity(db, stravaRun({ distance: 5200 }), "strava");
    const out = await processActivity(db, activity, { autoApprove: false });
    if (out.status !== "reward_created") throw new Error(out.status);
    id = out.rewardEventId;
    const bars = items.find((i) => i.title === "Protein bars")!.id;
    await runRewardAgent(db, id, {
      provider,
      createMessage: scriptedClaude([[toolUse("choose_reward", { item_id: bars, message: "Bars!" })]]).createMessage,
    });
    expect((await approveReward(db, id, "dashboard", { provider })).ok).toBe(true);
    await runCheckoutLoop(db, id, { provider, sleep: async () => {} }, { intervalMs: 0, budgetMs: 5 });
  });

  it("opens the checkout in your browser and waits for you", async () => {
    expect(opened).toEqual(["https://example.com/bars"]); // non-Shopify test URL → product page
    const [ev] = await db.select().from(rewardEvents).where(eq(rewardEvents.id, id));
    expect(ev.status).toBe("checking_out");
    expect(ev.checkoutState).toMatchObject({ state: "awaiting_input", handoffUrl: "https://example.com/bars" });
  });

  it("'I placed the order' completes it and settles the ledger at what you paid", async () => {
    expect(await confirmPurchase(db, id, { placed: true, totalCents: 29_10, orderNumber: "#1042" }, { provider })).toBe(true);
    const [ev] = await db.select().from(rewardEvents).where(eq(rewardEvents.id, id));
    expect(ev).toMatchObject({ status: "completed", totalChargedCents: 29_10 });
    expect(ev.receipt).toMatchObject({ orderId: "#1042", confirmedBy: "you" });
    const [l] = await db.select().from(spendLedger);
    expect(l).toMatchObject({ kind: "settled", amountCents: 29_10 });
  });

  it("'I didn't buy it' skips the reward and frees the budget", async () => {
    await confirmPurchase(db, id, { placed: false }, { provider });
    const [ev] = await db.select().from(rewardEvents).where(eq(rewardEvents.id, id));
    expect(ev.status).toBe("rejected");
    const [l] = await db.select().from(spendLedger);
    expect(l.kind).toBe("released");
  });
});
