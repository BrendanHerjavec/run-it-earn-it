import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { DB } from "@/db";
import { rewardEvents, settings, spendLedger } from "@/db/schema";
import { consumeApprovalToken } from "@/lib/approval";
import { resetConfigCache } from "@/lib/config";
import { setNotifyFetch, type NtfyMessage } from "@/lib/notify";
import { handleWebhookEvent } from "@/lib/pipeline";
import { MockProvider } from "@/lib/providers";
import { approveReward, runCheckoutLoop, runRewardAgent, skipReward, type RewardDeps } from "@/lib/rewards";
import { budgetStatus } from "@/lib/stats";
import { getEffectiveSettings } from "@/lib/settings";
import { addGoal, ATHLETE_ID, freshDb, seedWishlist, stravaRun } from "./helpers";
import { scriptedClaude, toolUse } from "./fake-claude";

let db: DB;
let items: Awaited<ReturnType<typeof seedWishlist>>;
let sent: (NtfyMessage & { topic: string })[];
let clock: number;
let deps: RewardDeps;

beforeEach(async () => {
  process.env.NTFY_TOPIC = "test-topic";
  process.env.APP_BASE_URL = "https://runny.example";
  resetConfigCache();
  db = await freshDb();
  items = await seedWishlist(db);
  await addGoal(db, { type: "single_run_distance", targetKm: 5, rewardTier: "medium", name: "Run 5 km" });

  sent = [];
  setNotifyFetch(async (_url, init) => {
    sent.push(JSON.parse(String(init?.body)));
    return new Response("{}", { status: 200 });
  });

  clock = Date.parse("2026-09-27T15:00:00Z");
  const provider = new MockProvider(() => clock);
  const bars = items.find((i) => i.title === "Protein bars")!.id;
  deps = {
    provider,
    createMessage: scriptedClaude([
      [toolUse("get_run_summary", {}), toolUse("list_wishlist", {})],
      [toolUse("choose_reward", { item_id: bars, message: "5.2 km in the bag. Chocolate protein bars, earned." })],
    ]).createMessage,
    // Each "sleep" jumps the mock checkout's clock forward instead of waiting.
    sleep: async (ms) => {
      clock += ms * 5;
    },
  };
});

async function webhookToAwaitingApproval() {
  const run = stravaRun({ distance: 5200 });
  let created: number | undefined;
  const out = await handleWebhookEvent(
    db,
    { object_type: "activity", object_id: run.id, aspect_type: "create", owner_id: ATHLETE_ID, subscription_id: 1, event_time: 0 },
    {
      fetchActivity: async () => run,
      onRewardCreated: async (_db, id) => {
        created = id;
        await runRewardAgent(db, id, deps);
      },
    },
  );
  expect(out.status).toBe("reward_created");
  return created!;
}

function tokenFrom(msg: NtfyMessage) {
  const approve = msg.actions!.find((a) => a.label === "Approve")!;
  return { url: approve.url, token: decodeURIComponent(new URL(approve.url).searchParams.get("token")!) };
}

describe("end to end with the mock provider", () => {
  it("webhook → Claude picks → ntfy Approve → checkout → receipt", async () => {
    const id = await webhookToAwaitingApproval();

    let [ev] = await db.select().from(rewardEvents).where(eq(rewardEvents.id, id));
    expect(ev.status).toBe("awaiting_approval");
    expect(ev.agentMessage).toMatch(/Chocolate protein bars, earned/);

    // The push notification carries the choice and a signed Approve link.
    expect(sent).toHaveLength(1);
    expect(sent[0].topic).toBe("test-topic");
    expect(sent[0].message).toContain("Protein bars ($24.99)");
    const { url, token } = tokenFrom(sent[0]);
    expect(url).toMatch(new RegExp(`^https://runny.example/api/rewards/${id}/approve\\?token=`));
    expect(sent[0].actions!.map((a) => a.label)).toEqual(["Approve", "Skip", "Open"]);

    // Tapping Approve: token consumed, then checkout starts with a hard cap.
    expect(await consumeApprovalToken(db, id, token)).toBe("ok");
    expect(await approveReward(db, id, "notification", deps)).toEqual({ ok: true });
    [ev] = await db.select().from(rewardEvents).where(eq(rewardEvents.id, id));
    expect(ev.status).toBe("checking_out");
    expect(ev.maxSpendCents).toBe(Math.ceil(24_99 * 1.1)); // quote + 10%, under the $40 cap
    let [ledger] = await db.select().from(spendLedger);
    expect(ledger).toMatchObject({ kind: "reserved", amountCents: ev.maxSpendCents });

    // A replayed tap does nothing.
    expect(await consumeApprovalToken(db, id, token)).toBe("expired_or_used");
    expect((await approveReward(db, id, "notification", deps)).ok).toBe(false);

    // Checkout runs to completion.
    const final = await runCheckoutLoop(db, id, deps, { intervalMs: 2000, budgetMs: 60_000 });
    expect(final).toBe("completed");
    [ev] = await db.select().from(rewardEvents).where(eq(rewardEvents.id, id));
    expect(ev.totalChargedCents).toBe(24_99);
    expect(ev.receipt).toMatchObject({ totalCents: 24_99, currency: "CAD", simulated: true });
    [ledger] = await db.select().from(spendLedger);
    expect(ledger).toMatchObject({ kind: "settled", amountCents: 24_99 });

    // Budget reflects the real charge, not the reservation.
    const b = await budgetStatus(db, await getEffectiveSettings(db), new Date(), "America/Toronto");
    expect(b.spentTodayCents).toBe(24_99);

    expect(sent.map((m) => m.title)).toEqual(["🏃 5.2 km done. Reward unlocked!", "🛒 Checkout started", "✅ Order placed"]);
  });

  it("re-checks caps at approval time and releases the reservation on failure", async () => {
    const id = await webhookToAwaitingApproval();
    // Between the pick and the tap, the per-order cap drops to $20.
    await db.insert(settings).values({ id: 1, maxOrderCents: 20_00 }).onConflictDoUpdate({ target: settings.id, set: { maxOrderCents: 20_00 } });
    const r = await approveReward(db, id, "dashboard", deps);
    expect(r.ok).toBe(false);
    const [ev] = await db.select().from(rewardEvents).where(eq(rewardEvents.id, id));
    expect(ev.status).toBe("failed");
    expect(ev.failureReason).toMatch(/over the \$20\.00/);
    expect(await db.select().from(spendLedger)).toHaveLength(0);
    expect(sent.at(-1)?.title).toMatch(/didn't go through/);
  });

  it("Skip rejects the reward and burns the link", async () => {
    const id = await webhookToAwaitingApproval();
    const { token } = tokenFrom(sent[0]);
    expect(await skipReward(db, id, "dashboard")).toBe(true);
    expect(await consumeApprovalToken(db, id, token)).toBe("expired_or_used");
    const [ev] = await db.select().from(rewardEvents).where(eq(rewardEvents.id, id));
    expect(ev.status).toBe("rejected");
  });

  it("auto-buy skips the Approve tap only when both switches are on and the item is under the auto cap", async () => {
    process.env.AUTO_BUY = "true";
    process.env.AUTO_BUY_MAX_CAD = "30";
    resetConfigCache();
    try {
      await db.insert(settings).values({ id: 1, autoBuy: true }).onConflictDoUpdate({ target: settings.id, set: { autoBuy: true } });
      const id = await webhookToAwaitingApproval();
      const [ev] = await db.select().from(rewardEvents);
      expect(ev.status).toBe("checking_out");
      expect(ev.approvedVia).toBe("auto");
      expect(ev.maxSpendCents).toBeLessThanOrEqual(30_00);
      expect(sent.map((m) => m.title)).toEqual(["🛒 Checkout started"]);
      expect(id).toBe(ev.id);
    } finally {
      process.env.AUTO_BUY = "false";
      process.env.AUTO_BUY_MAX_CAD = "15";
      resetConfigCache();
    }
  });

  it("the agent never runs twice for one reward", async () => {
    const id = await webhookToAwaitingApproval();
    await runRewardAgent(db, id, deps); // e.g. a retried background task
    expect(sent).toHaveLength(1);
  });
});

describe("Sync runs: automatic purchase after a countdown", () => {
  async function syncedReward(sleep: RewardDeps["sleep"]) {
    const run = stravaRun({ distance: 5200 });
    let created: number | undefined;
    await handleWebhookEvent(
      db,
      { object_type: "activity", object_id: run.id, aspect_type: "create", owner_id: ATHLETE_ID, subscription_id: 1, event_time: 0 },
      {
        autoApprove: true,
        fetchActivity: async () => run,
        onRewardCreated: async (_db, id) => {
          created = id;
          await runRewardAgent(db, id, { ...deps, sleep });
        },
      },
    );
    return created!;
  }

  it("buys without an Approve tap once the countdown ends", async () => {
    let waited = 0;
    const id = await syncedReward(async (ms) => {
      waited = ms;
    });
    const [ev] = await db.select().from(rewardEvents).where(eq(rewardEvents.id, id));
    expect(ev.autoApprove).toBe(true);
    expect(waited).toBeGreaterThan(8_000); // ~10 s countdown
    expect(ev.status).toBe("checking_out");
    expect(ev.approvedVia).toBe("sync");
    // No Approve/Skip buttons on the notification: the Sync click was the consent.
    expect(sent[0].actions).toBeUndefined();
    expect(await runCheckoutLoop(db, id, deps, { intervalMs: 2000, budgetMs: 60_000 })).toBe("completed");
  });

  it("Cancel during the countdown stops the purchase", async () => {
    let id = 0;
    id = await syncedReward(async () => {
      // The runner hits Cancel while the countdown is running.
      const [row] = await db.select().from(rewardEvents);
      await skipReward(db, row.id, "dashboard");
    });
    const [ev] = await db.select().from(rewardEvents).where(eq(rewardEvents.id, id));
    expect(ev.status).toBe("rejected");
    expect(await db.select().from(spendLedger)).toHaveLength(0);
  });
});
