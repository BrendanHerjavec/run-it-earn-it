import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { DB } from "@/db";
import { eventLog, rewardEvents, wishlistItems } from "@/db/schema";
import { runAgent } from "@/lib/agent";
import { processActivity, storeActivity } from "@/lib/pipeline";
import { MockProvider } from "@/lib/providers";
import { addGoal, freshDb, seedWishlist, stravaRun } from "./helpers";
import { scriptedClaude, text, thinking, toolUse } from "./fake-claude";

let db: DB;
let items: Awaited<ReturnType<typeof seedWishlist>>;
let rewardId: number;
const provider = new MockProvider();

beforeEach(async () => {
  db = await freshDb();
  items = await seedWishlist(db); // gels $12 small, bars $24.99 medium, vest $35 large
  await addGoal(db, { type: "single_run_distance", targetKm: 5, rewardTier: "medium", name: "Run 5 km" });
  const { activity } = await storeActivity(db, stravaRun({ distance: 5200 }), "strava");
  const out = await processActivity(db, activity);
  if (out.status !== "reward_created") throw new Error(out.status);
  rewardId = out.rewardEventId;
});

const byTitle = (t: string) => items.find((i) => i.title === t)!.id;

describe("reward agent", () => {
  it("looks at the run, budget and wishlist, then records a valid choice", async () => {
    const claude = scriptedClaude([
      [thinking("Let me look at the run first."), toolUse("get_run_summary", {}), toolUse("get_budget_status", {}), toolUse("list_wishlist", {})],
      [toolUse("choose_reward", { item_id: byTitle("Protein bars"), message: "5.2 km! Refuel with chocolate." })],
    ]);
    const r = await runAgent(db, rewardId, { createMessage: claude.createMessage, provider });
    expect(r).toMatchObject({ ok: true, itemId: byTitle("Protein bars"), quotedTotalCents: 28_24 });

    // Parallel tool calls come back in ONE user message, matched by id.
    const second = claude.requests[1].messages;
    const toolResults = second[second.length - 1];
    expect(toolResults.role).toBe("user");
    expect(Array.isArray(toolResults.content) && toolResults.content.map((b) => b.type)).toEqual(["tool_result", "tool_result", "tool_result"]);

    // The wishlist result tells Claude which items are eligible and why not.
    const wishlist = JSON.parse((toolResults.content as { content: string }[])[2].content);
    expect(wishlist.find((w: { title: string }) => w.title === "Vest")).toMatchObject({ eligible: false });
    expect(wishlist.find((w: { title: string }) => w.title === "Protein bars")).toMatchObject({ eligible: true });

    // Transcript (with thinking) is saved for the video; every tool call is logged.
    const [ev] = await db.select().from(rewardEvents).where(eq(rewardEvents.id, rewardId));
    expect(JSON.stringify(ev.agentTranscript)).toContain("Let me look at the run first.");
    const logs = await db.select().from(eventLog).where(eq(eventLog.rewardEventId, rewardId));
    expect(logs.filter((l) => l.kind === "agent.tool")).toHaveLength(4);
  });

  it("rejects an above-tier item and an invented id, and lets Claude pick again", async () => {
    const claude = scriptedClaude([
      [toolUse("choose_reward", { item_id: byTitle("Vest"), message: "Vest!" })],
      [toolUse("choose_reward", { item_id: 99999, message: "Made up" })],
      [toolUse("choose_reward", { item_id: byTitle("Gels"), message: "Gels it is." })],
    ]);
    const r = await runAgent(db, rewardId, { createMessage: claude.createMessage, provider });
    expect(r).toMatchObject({ ok: true, itemId: byTitle("Gels") });

    const errors = (await db.select().from(eventLog).where(eq(eventLog.rewardEventId, rewardId))).filter((l) => l.kind === "agent.tool_error");
    expect(errors.map((e) => e.message).join("\n")).toMatch(/tier large is above/);
    expect(errors.map((e) => e.message).join("\n")).toMatch(/No wishlist item with id 99999/);
  });

  it("won't choose an item that fits the tier but not the remaining budget", async () => {
    // $24.99 bars = $28.24 with tax. Tighten the per-order cap to $25.
    const { settings } = await import("@/db/schema");
    await db.insert(settings).values({ id: 1, maxOrderCents: 25_00 }).onConflictDoUpdate({ target: settings.id, set: { maxOrderCents: 25_00 } });
    const claude = scriptedClaude([[toolUse("choose_reward", { item_id: byTitle("Protein bars"), message: "Bars!" })], [text("Nothing else fits.")]]);
    const r = await runAgent(db, rewardId, { createMessage: claude.createMessage, provider });
    expect(r.ok).toBe(false);
    const errors = (await db.select().from(eventLog).where(eq(eventLog.rewardEventId, rewardId))).filter((l) => l.kind === "agent.tool_error");
    expect(errors[0].message).toMatch(/over the \$25\.00 available/);
  });

  it("fails cleanly without an API key", async () => {
    const r = await runAgent(db, rewardId, { provider });
    expect(r).toEqual({ ok: false, reason: "ANTHROPIC_API_KEY is not set" });
  });

  it("ignores inactive items even if Claude asks for one", async () => {
    await db.update(wishlistItems).set({ active: false }).where(eq(wishlistItems.id, byTitle("Gels")));
    const claude = scriptedClaude([[toolUse("choose_reward", { item_id: byTitle("Gels"), message: "Gels" })], [text("ok")]]);
    const r = await runAgent(db, rewardId, { createMessage: claude.createMessage, provider });
    expect(r.ok).toBe(false);
  });
});
