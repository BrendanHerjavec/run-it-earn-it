import { and, asc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import type { DB } from "@/db";
import { activities, challenges, eventLog, goals, orders, rewardEvents, spendLedger, wishlistItems, type Order } from "@/db/schema";
import { rewardPageUrl } from "./approval";
import { challengeWindow, type ChallengeWindow } from "./challenges";
import { config } from "./config";
import { logEvent } from "./events";
import { formatCad } from "./format";
import { notify } from "./notify";
import { buyerFromUser, getProvider, providerByName, type CheckoutLine, type CheckoutProvider, type CheckoutStatus } from "./providers";
import { CapError, ESTIMATE_BUFFER, QUOTE_BUFFER } from "./checkout-shared";
import type { RewardDeps } from "./rewards";
import { getEffectiveSettings, getUser } from "./settings";
import { budgetStatus } from "./stats";
import { addDays, localDateStart } from "./time";

/**
 * Basket challenges: each milestone's pick waits "in_basket"; when the window
 * ends (or you press "Check out now") all of them are bought as ONE order,
 * e.g. three bags of coffee → free shipping.
 */

export type BasketLine = {
  rewardId: number;
  milestoneKm: number | null;
  message: string | null;
  item: typeof wishlistItems.$inferSelect;
};

const orderPageUrl = (id: number) => `${config().APP_BASE_URL.replace(/\/$/, "")}/orders/${id}`;

function windowBounds(c: { startsOn: string; lengthDays: number }, startKey: string, timeZone: string) {
  return { start: localDateStart(startKey, timeZone), end: localDateStart(addDays(startKey, c.lengthDays), timeZone) };
}

/** The picks waiting in a challenge window's basket (or already attached to its order). */
export async function basketLines(db: DB, challengeId: number, startKey: string, timeZone: string, orderId?: number): Promise<BasketLine[]> {
  const [c] = await db.select().from(challenges).where(eq(challenges.id, challengeId));
  if (!c) return [];
  const { start, end } = windowBounds(c, startKey, timeZone);
  const rows = await db
    .select({ id: rewardEvents.id, km: goals.targetKm, message: rewardEvents.agentMessage, item: wishlistItems })
    .from(rewardEvents)
    .innerJoin(goals, eq(rewardEvents.goalId, goals.id))
    .innerJoin(activities, eq(rewardEvents.activityId, activities.id))
    .innerJoin(wishlistItems, eq(rewardEvents.chosenItemId, wishlistItems.id))
    .where(
      and(
        eq(goals.challengeId, challengeId),
        gte(activities.startTime, start),
        lt(activities.startTime, end),
        orderId != null ? eq(rewardEvents.orderId, orderId) : and(eq(rewardEvents.status, "in_basket"), isNull(rewardEvents.orderId)),
      ),
    )
    .orderBy(asc(goals.targetKm));
  return rows.map((r) => ({ rewardId: r.id, milestoneKm: r.km, message: r.message, item: r.item }));
}

export const basketTotalCents = (lines: BasketLine[]) => lines.reduce((s, l) => s + l.item.expectedPriceCents, 0);

/** Group identical picks into checkout lines (two milestones → same bag → qty 2). */
function toCheckoutLines(lines: BasketLine[]): CheckoutLine[] {
  const byItem = new Map<number, CheckoutLine>();
  for (const l of lines) {
    const cur = byItem.get(l.item.id);
    if (cur) cur.qty++;
    else byItem.set(l.item.id, { item: l.item, qty: 1 });
  }
  return [...byItem.values()];
}

export type OrderDeps = RewardDeps;

/**
 * Create the window's order (one per challenge window), with the picks
 * attached and a cancellable countdown. Returns null if the basket is empty
 * or the window already has an order.
 */
export async function createBasketOrder(db: DB, challengeId: number, startKey: string): Promise<number | null> {
  const user = await getUser(db);
  const lines = await basketLines(db, challengeId, startKey, user.timezone);
  if (!lines.length) return null;
  const at = new Date(Date.now() + config().SYNC_COUNTDOWN_S * 1000);
  const [order] = await db
    .insert(orders)
    .values({ challengeId, windowStartKey: startKey, status: "awaiting_approval", autoApproveAt: at })
    .onConflictDoNothing({ target: [orders.challengeId, orders.windowStartKey] })
    .returning();
  if (!order) return null;
  await db.update(rewardEvents).set({ orderId: order.id }).where(inArray(rewardEvents.id, lines.map((l) => l.rewardId)));
  await logEvent(db, {
    kind: "order.created",
    orderId: order.id,
    message: `Basket order: ${lines.map((l) => l.item.title).join(" + ")} (${formatCad(basketTotalCents(lines))} before tax)`,
  });
  await notify(
    db,
    {
      title: "🛒 Your week's basket is ready",
      message: `${lines.length} reward${lines.length === 1 ? "" : "s"}: ${lines.map((l) => l.item.title).join(", ")}`,
      tags: ["shopping_cart"],
      click: orderPageUrl(order.id),
    },
    {},
  );
  return order.id;
}

/** Wait out the countdown (Cancel drops the order), then check out and follow it to the end. */
export async function runBasketOrder(db: DB, id: number, deps: OrderDeps = {}) {
  const [o] = await db.select().from(orders).where(eq(orders.id, id));
  if (!o || o.status !== "awaiting_approval") return;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  await sleep(Math.max(0, (o.autoApproveAt?.getTime() ?? Date.now()) - Date.now()));
  const r = await approveOrder(db, id, deps);
  if (r.ok) await runOrderLoop(db, id, deps);
}

/** Cancel during the countdown: the order is dropped and the picks stay in the basket. */
export async function cancelPendingOrder(db: DB, orderId: number): Promise<boolean> {
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as DB;
    const [o] = await tx.select().from(orders).where(eq(orders.id, orderId));
    if (!o || o.status !== "awaiting_approval") return false;
    await tx.update(rewardEvents).set({ orderId: null }).where(eq(rewardEvents.orderId, orderId));
    await tx.delete(orders).where(eq(orders.id, orderId));
    return true;
  });
}

async function orderTransition(db: DB, id: number, from: Order["status"][], to: Order["status"], set: Partial<typeof orders.$inferInsert> = {}, note = "") {
  const [row] = await db
    .update(orders)
    .set({ ...set, status: to })
    .where(and(eq(orders.id, id), inArray(orders.status, from)))
    .returning();
  if (row) await logEvent(db, { kind: "order.state", orderId: id, message: `${from.join("|")} → ${to}${note ? `: ${note}` : ""}` });
  return row ?? null;
}

async function failOrder(db: DB, id: number, from: Order["status"][], reason: string) {
  const row = await orderTransition(db, id, from, "failed", { failureReason: reason, completedAt: new Date() }, reason);
  if (!row) return;
  await db.update(spendLedger).set({ kind: "released" }).where(and(eq(spendLedger.orderId, id), eq(spendLedger.kind, "reserved")));
  await notify(db, { title: "⚠️ Basket order didn't go through", message: reason, tags: ["warning"], click: orderPageUrl(id) }, {});
}

export async function approveOrder(db: DB, id: number, deps: OrderDeps = {}): Promise<{ ok: boolean; reason?: string }> {
  const [o] = await db.select().from(orders).where(eq(orders.id, id));
  // Cancel deletes the order, so a missing row means "cancelled".
  if (!o || o.status !== "awaiting_approval") return { ok: false, reason: "This order is no longer waiting" };
  const user = await getUser(db);
  const lines = toCheckoutLines(await basketLines(db, o.challengeId, o.windowStartKey, user.timezone, id));
  if (!lines.length) {
    await failOrder(db, id, ["awaiting_approval"], "The basket is empty");
    return { ok: false, reason: "The basket is empty" };
  }
  const settings = await getEffectiveSettings(db);
  const provider: CheckoutProvider = deps.provider ?? getProvider(settings);
  const buyer = buyerFromUser(user);

  let maxSpendCents: number;
  let quotedTotal: number;
  try {
    [maxSpendCents, quotedTotal] = await db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as DB;
      await tx.execute(sql`select pg_advisory_xact_lock(424242)`);
      const budget = await budgetStatus(tx, settings, new Date(), user.timezone);
      const quote = await provider.quote(lines, buyer);
      const cap = budget.availableForNextOrderCents;
      if (quote.totalCents > cap) throw new CapError(`Basket total ${formatCad(quote.totalCents)} is over the ${formatCad(cap)} order limit`);
      const max = Math.min(cap, Math.ceil(quote.totalCents * (quote.exact ? QUOTE_BUFFER : ESTIMATE_BUFFER)));
      await tx.insert(spendLedger).values({ amountCents: max, currency: "CAD", orderId: id, kind: "reserved" });
      await logEvent(tx, { kind: "order.quote", orderId: id, message: `Quote ${formatCad(quote.totalCents)} (${provider.name}); hard cap ${formatCad(max)}`, data: { quote, budget } });
      return [max, quote.totalCents];
    });
  } catch (err) {
    const reason = err instanceof CapError ? err.message : `Could not reserve budget: ${String(err)}`;
    await failOrder(db, id, ["awaiting_approval"], reason);
    return { ok: false, reason };
  }

  const started = await orderTransition(db, id, ["awaiting_approval"], "checking_out", { provider: provider.name, maxSpendCents, quotedTotalCents: quotedTotal });
  if (!started) return { ok: false, reason: "Order changed state" };
  try {
    const run = await provider.start(lines, buyer, maxSpendCents);
    await db.update(orders).set({ providerRunId: run.runId }).where(eq(orders.id, id));
    await logEvent(db, { kind: "order.checkout_started", orderId: id, message: `${provider.name} run ${run.runId}` });
  } catch (err) {
    await failOrder(db, id, ["checking_out"], `Checkout could not start: ${String(err)}`);
    return { ok: false, reason: String(err) };
  }
  return { ok: true };
}

/** Poll the provider once for an order and apply the result. */
export async function advanceOrder(db: DB, id: number, deps: OrderDeps = {}): Promise<Order["status"] | null> {
  const [o] = await db.select().from(orders).where(eq(orders.id, id));
  if (!o) return null;
  if (o.status !== "checking_out" || !o.providerRunId || !o.provider) return o.status;
  let st: CheckoutStatus;
  try {
    const provider = deps.provider ?? providerByName(o.provider, await getEffectiveSettings(db));
    st = await provider.status(o.providerRunId);
  } catch (err) {
    await logEvent(db, { kind: "order.poll_error", orderId: id, message: String(err) });
    return o.status;
  }
  const prev = o.checkoutState as CheckoutStatus | null;
  await db.update(orders).set({ checkoutState: st }).where(eq(orders.id, id));
  if (st.step && st.step !== prev?.step) await logEvent(db, { kind: "order.step", orderId: id, message: st.step });
  if (st.state === "awaiting_input" && prev?.state !== "awaiting_input") {
    await notify(
      db,
      st.handoffUrl
        ? { title: "🛒 Your basket is ready to pay", message: "Finish paying in your browser", priority: 4, click: st.handoffUrl }
        : { title: "🖐️ Checkout needs you", message: st.needsInput?.question ?? "Check the browser window", priority: 4, click: orderPageUrl(id) },
      {},
    );
  }

  if (st.state === "completed") {
    const dry = !!st.dryRun;
    const total = dry ? 0 : (st.totalCents ?? o.quotedTotalCents ?? 0);
    const done = await orderTransition(db, id, ["checking_out"], "completed", {
      totalChargedCents: total,
      receipt: st.receipt ?? { totalCents: st.totalCents },
      completedAt: new Date(),
    }, dry ? "dry run: stopped before placing the order" : "");
    if (done) {
      if (dry) {
        await db.update(spendLedger).set({ kind: "released" }).where(eq(spendLedger.orderId, id));
      } else {
        await db.update(spendLedger).set({ kind: "settled", amountCents: total }).where(eq(spendLedger.orderId, id));
        await db.update(rewardEvents).set({ status: "completed", completedAt: new Date() }).where(eq(rewardEvents.orderId, id));
      }
      await notify(
        db,
        {
          title: dry ? "🧪 Basket dry run finished" : "✅ Basket ordered",
          message: dry ? `Total would be ${formatCad(st.totalCents ?? 0)}. No order placed.` : `${formatCad(total)}${st.merchantOrderId ? `, order ${st.merchantOrderId}` : ""}`,
          click: orderPageUrl(id),
        },
        {},
      );
    }
    return "completed";
  }
  if (st.state === "cancelled" && st.failureReason === "Not purchased") {
    // You decided not to buy at checkout: the picks go back into the basket.
    const row = await orderTransition(db, id, ["checking_out"], "rejected", { completedAt: new Date() }, "you didn't buy it");
    if (row) await db.update(spendLedger).set({ kind: "released" }).where(eq(spendLedger.orderId, id));
    return "rejected";
  }
  if (st.state === "failed" || st.state === "cancelled") {
    await failOrder(db, id, ["checking_out"], st.failureReason ?? `Checkout ${st.state}`);
    return "failed";
  }
  return "checking_out";
}

export async function runOrderLoop(db: DB, id: number, deps: OrderDeps = {}, opts = { intervalMs: 2000, budgetMs: 20 * 60_000 }) {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const until = Date.now() + opts.budgetMs;
  while (Date.now() < until) {
    const status = await advanceOrder(db, id, deps);
    if (status !== "checking_out") return status;
    await sleep(opts.intervalMs);
  }
  return "checking_out" as const;
}

/** Cart-link checkout: you tell the app whether you placed the basket order. */
export async function confirmOrderPurchase(db: DB, id: number, c: { placed: boolean; totalCents?: number; orderNumber?: string }, deps: OrderDeps = {}) {
  const [o] = await db.select().from(orders).where(eq(orders.id, id));
  if (!o || o.status !== "checking_out" || !o.providerRunId) return false;
  const provider = deps.provider ?? providerByName(o.provider ?? "mock", await getEffectiveSettings(db));
  if (!provider.respond) return false;
  await provider.respond(o.providerRunId, c);
  await advanceOrder(db, id, deps);
  return true;
}

/**
 * Done with a failed / not-bought order: its picks go back in the basket and
 * the old order is renamed out of the way (keeping its log and released ledger
 * row), so the window can be ordered again.
 */
export async function reopenBasket(db: DB, id: number) {
  const [o] = await db.select().from(orders).where(eq(orders.id, id));
  if (!o || !["failed", "rejected"].includes(o.status)) return false;
  await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as DB;
    await tx.update(rewardEvents).set({ orderId: null, status: "in_basket" }).where(eq(rewardEvents.orderId, id));
    await tx.update(orders).set({ windowStartKey: `${o.windowStartKey}#${o.id}` }).where(eq(orders.id, id));
  });
  return true;
}

/**
 * Baskets whose window has ended and that still hold picks: these get ordered
 * on the next Sync. Returns [challengeId, windowStartKey] pairs.
 */
export async function dueBaskets(db: DB, now: Date, timeZone: string): Promise<{ challengeId: number; startKey: string }[]> {
  const list = await db.select().from(challenges).where(and(eq(challenges.active, true), eq(challenges.basketCheckout, true)));
  const due: { challengeId: number; startKey: string }[] = [];
  for (const c of list) {
    const current = challengeWindow(c, now, timeZone);
    // Look back over recent windows (the current one isn't finished yet).
    const lastIndex = current ? current.index - 1 : Math.floor((now.getTime() - localDateStart(c.startsOn, timeZone).getTime()) / (c.lengthDays * 86_400_000));
    for (let i = Math.max(0, lastIndex - 3); i <= lastIndex; i++) {
      if (!c.repeats && i > 0) break;
      const startKey = addDays(c.startsOn, i * c.lengthDays);
      if ((await basketLines(db, c.id, startKey, timeZone)).length) due.push({ challengeId: c.id, startKey });
    }
  }
  return due;
}

export type { ChallengeWindow };
export { rewardPageUrl };

/** The runner fixed something in the browser during a basket checkout; let the agent continue. */
export async function resumeOrder(db: DB, id: number, note: string, deps: OrderDeps = {}) {
  const [o] = await db.select().from(orders).where(eq(orders.id, id));
  if (!o || o.status !== "checking_out" || !o.providerRunId) return false;
  const provider = deps.provider ?? providerByName(o.provider ?? "mock", await getEffectiveSettings(db));
  if (!provider.respond) return false;
  await provider.respond(o.providerRunId, note);
  await logEvent(db, { kind: "order.resumed", orderId: id, message: note });
  return true;
}

export type OrderView = {
  id: number;
  status: Order["status"];
  challengeName: string;
  windowStartKey: string;
  autoApproveAt: string | null;
  provider: string | null;
  quotedTotalCents: number | null;
  maxSpendCents: number | null;
  totalChargedCents: number | null;
  receipt: unknown;
  failureReason: string | null;
  checkout: CheckoutStatus | null;
  lines: { rewardId: number; milestoneKm: number | null; message: string | null; title: string; priceCents: number; productUrl: string }[];
  log: { id: number; at: string; kind: string; message: string }[];
};

export async function getOrderView(db: DB, id: number): Promise<OrderView | null> {
  const [o] = await db.select().from(orders).where(eq(orders.id, id));
  if (!o) return null;
  const [c] = await db.select().from(challenges).where(eq(challenges.id, o.challengeId));
  const user = await getUser(db);
  const startKey = o.windowStartKey.split("#")[0];
  const lines = await basketLines(db, o.challengeId, startKey, user.timezone, id);
  const log = await db.select().from(eventLog).where(eq(eventLog.orderId, id)).orderBy(asc(eventLog.id));
  return {
    id: o.id,
    status: o.status,
    challengeName: c?.name ?? "Challenge",
    windowStartKey: startKey,
    autoApproveAt: o.autoApproveAt?.toISOString() ?? null,
    provider: o.provider,
    quotedTotalCents: o.quotedTotalCents,
    maxSpendCents: o.maxSpendCents,
    totalChargedCents: o.totalChargedCents,
    receipt: o.receipt,
    failureReason: o.failureReason,
    checkout: (o.checkoutState as CheckoutStatus | null) ?? null,
    lines: lines.map((l) => ({
      rewardId: l.rewardId,
      milestoneKm: l.milestoneKm,
      message: l.message,
      title: l.item.title,
      priceCents: l.item.expectedPriceCents,
      productUrl: l.item.productUrl,
    })),
    log: log.map((l) => ({ id: l.id, at: l.createdAt.toISOString(), kind: l.kind, message: l.message })),
  };
}
