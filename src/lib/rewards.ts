import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { DB } from "@/db";
import { activities, challenges, goals, rewardEvents, spendLedger, wishlistItems, type RewardEvent, type RewardStatus } from "@/db/schema";
import { runAgent, type AgentDeps } from "./agent";
import { approvalUrls, burnApprovalToken, issueApprovalToken, rewardPageUrl } from "./approval";
import { config } from "./config";
import { logEvent } from "./events";
import { formatCad, formatKm } from "./format";
import { notify } from "./notify";
import { buyerFromUser, getProvider, providerByName, TERMINAL, type CheckoutProvider, type CheckoutStatus } from "./providers";
import { CapError, ESTIMATE_BUFFER, QUOTE_BUFFER } from "./checkout-shared";
import { getEffectiveSettings, getUser } from "./settings";
import { budgetStatus } from "./stats";

export type RewardDeps = AgentDeps & {
  /** Overrides provider selection everywhere (tests). */
  provider?: CheckoutProvider;
  sleep?: (ms: number) => Promise<void>;
};


export type ApproveVia = "notification" | "dashboard" | "auto" | "sync";

/**
 * Compare-and-set status change. Returns the updated row, or null if the
 * reward was not in one of the `from` states (someone else got there first).
 */
async function transition(
  db: DB,
  id: number,
  from: RewardStatus[],
  to: RewardStatus,
  set: Partial<typeof rewardEvents.$inferInsert> = {},
  note = "",
): Promise<RewardEvent | null> {
  const [row] = await db
    .update(rewardEvents)
    .set({ ...set, status: to })
    .where(and(eq(rewardEvents.id, id), inArray(rewardEvents.status, from)))
    .returning();
  if (row) await logEvent(db, { kind: "reward.state", rewardEventId: id, message: `${from.join("|")} → ${to}${note ? `: ${note}` : ""}` });
  return row ?? null;
}

async function load(db: DB, id: number) {
  const [row] = await db
    .select({ event: rewardEvents, item: wishlistItems, activity: activities })
    .from(rewardEvents)
    .innerJoin(activities, eq(rewardEvents.activityId, activities.id))
    .leftJoin(wishlistItems, eq(rewardEvents.chosenItemId, wishlistItems.id))
    .where(eq(rewardEvents.id, id));
  return row ?? null;
}

async function fail(db: DB, id: number, from: RewardStatus[], reason: string) {
  const row = await transition(db, id, from, "failed", { failureReason: reason, completedAt: new Date() }, reason);
  if (!row) return;
  await db.update(spendLedger).set({ kind: "released" }).where(and(eq(spendLedger.rewardEventId, id), eq(spendLedger.kind, "reserved")));
  await notify(db, { title: "⚠️ Reward didn't go through", message: reason, tags: ["warning"], click: rewardPageUrl(id) }, { rewardEventId: id });
}

// ─── 1. Agent ─────────────────────────────────────────────────────────────

/** Claim the reward, run Claude, then ask for approval (or auto-buy). Safe to call twice. */
export async function runRewardAgent(db: DB, id: number, deps: RewardDeps = {}): Promise<void> {
  const [claimed] = await db
    .update(rewardEvents)
    .set({ agentStartedAt: new Date() })
    .where(and(eq(rewardEvents.id, id), eq(rewardEvents.status, "pending_agent"), isNull(rewardEvents.agentStartedAt)))
    .returning({ id: rewardEvents.id });
  if (!claimed) return;

  await logEvent(db, { kind: "agent.start", rewardEventId: id, message: `Claude (${config().ANTHROPIC_MODEL}) is choosing a reward` });
  const result = await runAgent(db, id, deps);
  if (!result.ok) {
    await logEvent(db, { kind: "agent.failed", rewardEventId: id, message: result.reason });
    await fail(db, id, ["pending_agent"], result.reason);
    return;
  }
  await db
    .update(rewardEvents)
    .set({ chosenItemId: result.itemId, agentMessage: result.message, quotedTotalCents: result.quotedTotalCents })
    .where(eq(rewardEvents.id, id));
  await logEvent(db, { kind: "agent.chose", rewardEventId: id, message: result.message, data: result });
  await afterChoice(db, id, deps);
}

async function isBasketGoal(db: DB, goalId: number): Promise<boolean> {
  const [row] = await db
    .select({ basket: challenges.basketCheckout })
    .from(goals)
    .innerJoin(challenges, eq(goals.challengeId, challenges.id))
    .where(eq(goals.id, goalId));
  return !!row?.basket;
}

async function afterChoice(db: DB, id: number, deps: RewardDeps) {
  const settings = await getEffectiveSettings(db);
  const row = await load(db, id);
  if (!row?.item) return;
  const quoted = row.event.quotedTotalCents ?? row.item.expectedPriceCents;

  // Basket challenges: the pick goes into this window's basket; one order is placed when the window ends.
  if (row.event.goalId != null && (await isBasketGoal(db, row.event.goalId))) {
    const moved = await transition(db, id, ["pending_agent"], "in_basket", {}, "added to the basket");
    if (moved) {
      await notify(
        db,
        {
          title: `🏃 ${formatKm(row.activity.distanceM)} done. Reward unlocked!`,
          message: `Into the basket: ${row.item.title} (${formatCad(row.item.expectedPriceCents)})

"${row.event.agentMessage}"`,
          tags: ["shopping_cart"],
          click: rewardPageUrl(id),
        },
        { rewardEventId: id },
      );
    }
    return;
  }

  // "Sync runs": clicking Sync was the consent. Buy after a short, cancellable countdown.
  if (row.event.autoApprove) {
    const at = new Date(Date.now() + config().SYNC_COUNTDOWN_S * 1000);
    const moved = await transition(db, id, ["pending_agent"], "awaiting_approval", { autoApproveAt: at }, `buying in ${config().SYNC_COUNTDOWN_S}s unless cancelled`);
    if (!moved) return;
    await notify(
      db,
      {
        title: `🏃 ${formatKm(row.activity.distanceM)} done. Reward unlocked!`,
        message: `Claude picked: ${row.item.title} (${formatCad(quoted)})

"${row.event.agentMessage}"`,
        tags: ["tada"],
        click: rewardPageUrl(id),
      },
      { rewardEventId: id },
    );
    const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    await sleep(Math.max(0, at.getTime() - Date.now()));
    // Cancel moves the reward to "rejected"; approveReward only proceeds from awaiting_approval.
    await approveReward(db, id, "sync", deps);
    return;
  }

  if (settings.autoBuy && quoted <= settings.autoBuyMaxCents) {
    await transition(db, id, ["pending_agent"], "awaiting_approval", {}, `auto-buy (≤ ${formatCad(settings.autoBuyMaxCents)})`);
    await approveReward(db, id, "auto", deps);
    return;
  }

  const moved = await transition(db, id, ["pending_agent"], "awaiting_approval");
  if (!moved) return;
  const token = await issueApprovalToken(db, id);
  const urls = approvalUrls(id, token);
  await notify(
    db,
    {
      title: `🏃 ${formatKm(row.activity.distanceM)} done. Reward unlocked!`,
      message: `Claude picked: ${row.item.title} (${formatCad(quoted)})\n\n"${row.event.agentMessage}"\n\nApprove?`,
      priority: 4,
      tags: ["tada"],
      click: urls.page,
      actions: [
        { action: "http", label: "Approve", url: urls.approve, method: "POST", clear: true },
        { action: "http", label: "Skip", url: urls.skip, method: "POST", clear: true },
        { action: "view", label: "Open", url: urls.page },
      ],
    },
    { rewardEventId: id },
  );
}

// ─── 2. Approval ──────────────────────────────────────────────────────────

export type ApproveResult = { ok: true } | { ok: false; reason: string };

/**
 * Approve and start the checkout. Every cap is re-checked here, at the moment
 * money could move, inside a lock so two approvals can't both spend the same budget.
 */
export async function approveReward(db: DB, id: number, via: ApproveVia, deps: RewardDeps = {}): Promise<ApproveResult> {
  const approved = await transition(db, id, ["awaiting_approval"], "approved", { approvedAt: new Date(), approvedVia: via }, `via ${via}`);
  if (!approved) return { ok: false, reason: "This reward is no longer waiting for approval" };
  await burnApprovalToken(db, id);

  const row = await load(db, id);
  if (!row?.item) {
    await fail(db, id, ["approved"], "No item was chosen");
    return { ok: false, reason: "No item was chosen" };
  }
  const item = row.item;
  const [settings, user] = await Promise.all([getEffectiveSettings(db), getUser(db)]);
  const provider = deps.provider ?? getProvider(settings);
  const buyer = buyerFromUser(user);

  let maxSpendCents: number;
  try {
    maxSpendCents = await db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as DB;
      await tx.execute(sql`select pg_advisory_xact_lock(424242)`);
      const budget = await budgetStatus(tx, settings, new Date(), user.timezone);
      const quote = await provider.quote([{ item, qty: 1 }], buyer);
      const cap = Math.min(budget.availableForNextOrderCents, via === "auto" ? settings.autoBuyMaxCents : Infinity);
      if (quote.totalCents > cap) {
        throw new CapError(`Quoted total ${formatCad(quote.totalCents)} is over the ${formatCad(cap)} you have left`);
      }
      const max = Math.min(cap, Math.ceil(quote.totalCents * (quote.exact ? QUOTE_BUFFER : ESTIMATE_BUFFER)));
      await tx.insert(spendLedger).values({ amountCents: max, currency: "CAD", rewardEventId: id, kind: "reserved" });
      await logEvent(tx, {
        kind: "checkout.quote",
        rewardEventId: id,
        message: `Quote ${formatCad(quote.totalCents)} (${provider.name}); hard cap ${formatCad(max)} reserved`,
        data: { quote, budget },
      });
      return max;
    });
  } catch (err) {
    const reason = err instanceof CapError ? err.message : `Could not reserve budget: ${String(err)}`;
    await fail(db, id, ["approved"], reason);
    return { ok: false, reason };
  }

  const started = await transition(db, id, ["approved"], "checking_out", { provider: provider.name, maxSpendCents });
  if (!started) return { ok: false, reason: "Reward changed state during approval" };
  try {
    const run = await provider.start([{ item, qty: 1 }], buyer, maxSpendCents);
    await db
      .update(rewardEvents)
      .set({ providerRunId: run.runId, liveViewUrl: run.liveViewUrl ?? null })
      .where(eq(rewardEvents.id, id));
    await logEvent(db, { kind: "checkout.started", rewardEventId: id, message: `${provider.name} run ${run.runId}`, data: run });
  } catch (err) {
    await fail(db, id, ["checking_out"], `Checkout could not start: ${String(err)}`);
    return { ok: false, reason: String(err) };
  }

  await notify(
    db,
    {
      title: "🛒 Checkout started",
      message: `${item.title}: hard cap ${formatCad(maxSpendCents)}${provider.name === "mock" ? " (simulated)" : ""}`,
      tags: ["shopping_cart"],
      click: rewardPageUrl(id),
      actions: [{ action: "view", label: "Watch live", url: rewardPageUrl(id) }],
    },
    { rewardEventId: id },
  );
  return { ok: true };
}


export async function skipReward(db: DB, id: number, via: "notification" | "dashboard"): Promise<boolean> {
  const row = await transition(db, id, ["awaiting_approval"], "rejected", { completedAt: new Date() }, `skipped via ${via}`);
  if (row) await burnApprovalToken(db, id);
  return !!row;
}

// ─── 3. Checkout progress ─────────────────────────────────────────────────

/** Poll the provider once and apply the result. Idempotent; safe from many callers. */
export async function advanceCheckout(db: DB, id: number, deps: RewardDeps = {}): Promise<RewardStatus | null> {
  const row = await load(db, id);
  if (!row) return null;
  const { event, item } = row;
  if (event.status !== "checking_out" || !event.providerRunId || !event.provider) return event.status;

  let provider: CheckoutProvider;
  let st: CheckoutStatus;
  try {
    provider = deps.provider ?? providerByName(event.provider, await getEffectiveSettings(db));
    st = await provider.status(event.providerRunId);
  } catch (err) {
    await logEvent(db, { kind: "checkout.poll_error", rewardEventId: id, message: String(err) });
    return event.status;
  }

  const prevStep = (event.checkoutState as CheckoutStatus | null)?.step;
  await db.update(rewardEvents).set({ checkoutState: st }).where(eq(rewardEvents.id, id));
  if (st.step && st.step !== prevStep) {
    await logEvent(db, { kind: "checkout.step", rewardEventId: id, message: st.step });
  }
  const prevState = (event.checkoutState as CheckoutStatus | null)?.state;
  if (st.state === "awaiting_input" && prevState !== "awaiting_input") {
    await notify(
      db,
      st.handoffUrl
        ? { title: "🛒 Your cart is ready", message: `${item?.title}: finish paying in your browser`, priority: 4, click: st.handoffUrl }
        : { title: "🖐️ Checkout needs you", message: st.needsInput?.question ?? "Check the browser window", priority: 4, click: rewardPageUrl(id) },
      { rewardEventId: id },
    );
  }

  if (st.state === "completed" && st.dryRun) {
    const done = await transition(db, id, ["checking_out"], "completed", {
      totalChargedCents: 0,
      receipt: st.receipt ?? { dryRun: true, totalCents: st.totalCents },
      completedAt: new Date(),
    }, "dry run: stopped before placing the order");
    if (done) {
      await db.update(spendLedger).set({ kind: "released" }).where(eq(spendLedger.rewardEventId, id));
      await notify(
        db,
        { title: "🧪 Dry run finished", message: `${item?.title}: total would be ${formatCad(st.totalCents ?? 0)}. No order placed.`, click: rewardPageUrl(id) },
        { rewardEventId: id },
      );
    }
    return "completed";
  }
  if (st.state === "completed") {
    // Cart checkouts: you may not enter the exact total; fall back to the quote.
    const total = st.totalCents ?? event.quotedTotalCents ?? 0;
    const cap = event.maxSpendCents ?? 0;
    if (total > cap) {
      // The provider is supposed to make this impossible. Record it loudly.
      await logEvent(db, { kind: "checkout.cap_breach", rewardEventId: id, message: `Charged ${formatCad(total)} over cap ${formatCad(cap)}` });
    }
    const done = await transition(db, id, ["checking_out"], "completed", {
      totalChargedCents: total,
      receipt: st.receipt ?? { merchantOrderId: st.merchantOrderId, totalCents: total },
      completedAt: new Date(),
    });
    if (done) {
      await db
        .update(spendLedger)
        .set({ kind: "settled", amountCents: total, currency: st.currency ?? "CAD" })
        .where(eq(spendLedger.rewardEventId, id));
      await notify(
        db,
        {
          title: "✅ Order placed",
          message: `${item?.title}: ${formatCad(total)}${st.merchantOrderId ? `, order ${st.merchantOrderId}` : ""}`,
          tags: ["white_check_mark"],
          click: rewardPageUrl(id),
        },
        { rewardEventId: id },
      );
    }
    return "completed";
  }
  if (st.state === "cancelled" && st.failureReason === "Not purchased") {
    // You chose not to buy it at checkout: no failure, just a skipped reward.
    const row = await transition(db, id, ["checking_out"], "rejected", { completedAt: new Date() }, "you didn't buy it");
    if (row) await db.update(spendLedger).set({ kind: "released" }).where(eq(spendLedger.rewardEventId, id));
    return "rejected";
  }
  if (st.state === "failed" || st.state === "cancelled") {
    await fail(db, id, ["checking_out"], st.failureReason ?? `Checkout ${st.state}`);
    return "failed";
  }
  return "checking_out";
}

/** Keep polling until the checkout finishes or the time budget runs out (the dashboard keeps polling after). */
export async function runCheckoutLoop(db: DB, id: number, deps: RewardDeps = {}, opts = { intervalMs: 2000, budgetMs: 20 * 60_000 }) {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const until = Date.now() + opts.budgetMs;
  while (Date.now() < until) {
    const status = await advanceCheckout(db, id, deps);
    if (status !== "checking_out") return status;
    await sleep(opts.intervalMs);
  }
  return "checking_out" as const;
}

/** Cart-link checkout: you tell the app whether you placed the order (and optionally the total). */
export async function confirmPurchase(
  db: DB,
  id: number,
  c: { placed: boolean; totalCents?: number; orderNumber?: string },
  deps: RewardDeps = {},
): Promise<boolean> {
  const row = await load(db, id);
  if (!row || row.event.status !== "checking_out" || !row.event.providerRunId) return false;
  const provider = deps.provider ?? providerByName(row.event.provider ?? "mock", await getEffectiveSettings(db));
  if (!provider.respond) return false;
  await provider.respond(row.event.providerRunId, c);
  await logEvent(db, {
    kind: "checkout.confirmed",
    rewardEventId: id,
    message: c.placed ? `You placed the order${c.totalCents ? ` (${formatCad(c.totalCents)})` : ""}` : "You didn't buy it",
  });
  await advanceCheckout(db, id, deps);
  return true;
}

/** The runner fixed something in the browser (signed in, entered a code); let the agent continue. */
export async function resumeCheckout(db: DB, id: number, note: string, deps: RewardDeps = {}) {
  const row = await load(db, id);
  if (!row || row.event.status !== "checking_out" || !row.event.providerRunId) return false;
  const provider = deps.provider ?? providerByName(row.event.provider ?? "mock", await getEffectiveSettings(db));
  if (!provider.respond) return false;
  await provider.respond(row.event.providerRunId, note);
  await logEvent(db, { kind: "checkout.resumed", rewardEventId: id, message: note || "continue" });
  return true;
}

export async function cancelCheckout(db: DB, id: number, deps: RewardDeps = {}) {
  const row = await load(db, id);
  if (!row || row.event.status !== "checking_out") return false;
  try {
    const provider = deps.provider ?? providerByName(row.event.provider ?? "mock", await getEffectiveSettings(db));
    if (row.event.providerRunId) await provider.cancel(row.event.providerRunId);
  } catch (err) {
    await logEvent(db, { kind: "checkout.cancel_error", rewardEventId: id, message: String(err) });
  }
  await fail(db, id, ["checking_out"], "Cancelled by you");
  return true;
}

/** Let the agent try again after it failed (only if no money was ever reserved). */
export async function retryAgent(db: DB, id: number) {
  const [ledger] = await db.select().from(spendLedger).where(eq(spendLedger.rewardEventId, id));
  if (ledger) return false;
  const row = await transition(
    db,
    id,
    ["failed"],
    "pending_agent",
    { agentStartedAt: null, failureReason: null, chosenItemId: null, agentMessage: null, agentTranscript: null, completedAt: null },
    "retry",
  );
  return !!row;
}

export { TERMINAL };
