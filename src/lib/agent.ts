import Anthropic from "@anthropic-ai/sdk";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { DB } from "@/db";
import { activities, goals, rewardEvents, wishlistItems, type Activity, type Goal, type RewardEvent, type WishlistItem } from "@/db/schema";
import { config } from "./config";
import { logEvent } from "./events";
import { formatCad, formatDuration, formatPace } from "./format";
import { buyerFromUser, getProvider, type CheckoutProvider } from "./providers";
import { getEffectiveSettings, getUser } from "./settings";
import { budgetStatus, runStreakDays, weeklyDistanceM, type BudgetStatus } from "./stats";
import { TIER_MAX_CENTS, tierAllows, type Tier } from "./tiers";

export const SYSTEM_PROMPT = `You are the runner's hype coach inside "Run It, Earn It". When they finish a run that hits a goal, you pick ONE reward from their wishlist and write them a short message about why they earned it.

How to work:
1. Call get_run_summary, get_budget_status and list_wishlist to see the run, the money available, and the options.
2. Pick the item that best fits this particular effort: a bigger or tougher run earns something better; a quest deserves something fun. Use the item notes.
3. Call choose_reward exactly once with the item's id and your message.

Hard rules (the server enforces these; breaking them just wastes a turn):
- Only choose an item returned by list_wishlist, by its id. Never invent products, prices or links.
- The item must be marked eligible: within the reward tier for this goal and within the remaining budget including tax.
- If choose_reward returns an error, read it and pick a different eligible item.
- If nothing is eligible, don't call choose_reward; say so in one sentence.

The message is shown on the runner's phone and on camera. Keep it to 1–2 sentences, under 240 characters, playful and specific to this run (distance, pace, the quest, the streak). Metric units, Canadian spelling, no hashtags.`;

export type CreateMessage = (params: Anthropic.MessageCreateParamsNonStreaming) => Promise<Anthropic.Message>;

export type AgentDeps = {
  createMessage?: CreateMessage;
  provider?: CheckoutProvider;
  now?: () => Date;
};

export type AgentResult =
  | { ok: true; itemId: number; message: string; quotedTotalCents: number }
  | { ok: false; reason: string };

const TOOLS: Anthropic.Tool[] = [
  {
    name: "get_run_summary",
    description: "The run that earned this reward: distance, pace, time, which goal or quest it hit, weekly total and streak.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_wishlist",
    description:
      "Active wishlist items with id, title, price, tier, notes, estimated total including tax, and whether each is eligible for this reward. Optionally filter by tier.",
    input_schema: {
      type: "object",
      properties: { tier: { type: "string", enum: ["small", "medium", "large"], description: "Only list items of this tier" } },
      additionalProperties: false,
    },
  },
  {
    name: "get_budget_status",
    description: "Remaining reward budget in CAD: per-order cap, what's left today and this week, and the most the next reward may cost.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "choose_reward",
    description:
      "Record your choice. The server re-checks the item, tier and price against the caps and returns an error if the choice is not allowed. Call once.",
    input_schema: {
      type: "object",
      properties: {
        item_id: { type: "integer", description: "id from list_wishlist" },
        message: { type: "string", description: "1–2 playful sentences for the runner, under 240 characters" },
      },
      required: ["item_id", "message"],
      additionalProperties: false,
    },
  },
];

type Ctx = {
  db: DB;
  event: RewardEvent;
  activity: Activity;
  goal: Goal;
  budget: BudgetStatus;
  provider: CheckoutProvider;
  timeZone: string;
  chosen?: { itemId: number; message: string; quotedTotalCents: number };
};

const chooseSchema = z.object({ item_id: z.number().int(), message: z.string().trim().min(1).max(280) });
const listSchema = z.object({ tier: z.enum(["small", "medium", "large"]).optional() });

/** The most this reward may cost, including tax: remaining budget, capped by the goal's tier band. */
function ceilingCents(ctx: Ctx) {
  return Math.min(ctx.budget.availableForNextOrderCents, TIER_MAX_CENTS[ctx.goal.rewardTier as Tier]);
}

async function eligibility(ctx: Ctx, item: WishlistItem) {
  const user = await getUser(ctx.db);
  const quote = await ctx.provider.quote(item, buyerFromUser(user));
  const reasons: string[] = [];
  if (!item.active) reasons.push("inactive");
  if (!tierAllows(ctx.goal.rewardTier as Tier, item.tier as Tier)) reasons.push(`tier ${item.tier} is above this goal's ${ctx.goal.rewardTier} tier`);
  if (item.expectedPriceCents > TIER_MAX_CENTS[ctx.goal.rewardTier as Tier])
    reasons.push(`price is above the ${ctx.goal.rewardTier} tier limit of ${formatCad(TIER_MAX_CENTS[ctx.goal.rewardTier as Tier])}`);
  if (quote.totalCents > ctx.budget.availableForNextOrderCents)
    reasons.push(`estimated total ${formatCad(quote.totalCents)} is over the ${formatCad(ctx.budget.availableForNextOrderCents)} available`);
  return { eligible: reasons.length === 0, reasons, quote };
}

async function runTool(ctx: Ctx, name: string, input: unknown): Promise<{ content: string; isError?: boolean }> {
  const { db, activity, goal, budget } = ctx;
  switch (name) {
    case "get_run_summary": {
      const [weekM, streak] = await Promise.all([
        weeklyDistanceM(db, activity.startTime, ctx.timeZone),
        runStreakDays(db, activity.startTime, ctx.timeZone),
      ]);
      const goalMet = (await db.select().from(goals).where(eq(goals.id, goal.id)))[0];
      return {
        content: JSON.stringify({
          distance_km: +(activity.distanceM / 1000).toFixed(2),
          moving_time: formatDuration(activity.movingTimeS),
          pace_per_km: formatPace(activity.movingTimeS, activity.distanceM),
          type: activity.sportType,
          name: activity.name,
          started_at_local: activity.startTime.toLocaleString("en-CA", { timeZone: ctx.timeZone }),
          goal_hit: {
            name: goalMet.name,
            type: goalMet.type,
            target_km: goalMet.targetKm,
            quest_radius_m: goalMet.radiusM,
            reward_tier: goalMet.rewardTier,
          },
          week_total_km: +(weekM / 1000).toFixed(2),
          streak_days: streak,
        }),
      };
    }
    case "get_budget_status":
      return {
        content: JSON.stringify({
          currency: "CAD",
          per_order_cap: formatCad(budget.maxOrderCents),
          left_today: formatCad(budget.remainingDailyCents),
          left_this_week: formatCad(budget.remainingWeeklyCents),
          max_for_this_reward_incl_tax: formatCad(ceilingCents(ctx)),
          reward_tier: goal.rewardTier,
          tier_price_limit: formatCad(TIER_MAX_CENTS[goal.rewardTier as Tier]),
        }),
      };
    case "list_wishlist": {
      const { tier } = listSchema.parse(input ?? {});
      const conds = [eq(wishlistItems.active, true)];
      if (tier) conds.push(eq(wishlistItems.tier, tier));
      const items = await db.select().from(wishlistItems).where(and(...conds));
      const rows = await Promise.all(
        items.map(async (item) => {
          const e = await eligibility(ctx, item);
          return {
            id: item.id,
            title: item.title,
            price: formatCad(item.expectedPriceCents),
            estimated_total_incl_tax: formatCad(e.quote.totalCents),
            tier: item.tier,
            notes: item.notes,
            eligible: e.eligible,
            ...(e.eligible ? {} : { why_not: e.reasons.join("; ") }),
          };
        }),
      );
      return { content: JSON.stringify(rows) };
    }
    case "choose_reward": {
      if (ctx.chosen) return { content: "You already chose a reward for this run.", isError: true };
      const parsed = chooseSchema.safeParse(input);
      if (!parsed.success) return { content: `Invalid input: ${parsed.error.issues.map((i) => i.message).join("; ")}`, isError: true };
      const [item] = await db.select().from(wishlistItems).where(eq(wishlistItems.id, parsed.data.item_id));
      if (!item) return { content: `No wishlist item with id ${parsed.data.item_id}. Use an id from list_wishlist.`, isError: true };
      const e = await eligibility(ctx, item);
      if (!e.eligible) return { content: `Not allowed: ${e.reasons.join("; ")}. Pick a different eligible item.`, isError: true };
      ctx.chosen = { itemId: item.id, message: parsed.data.message, quotedTotalCents: e.quote.totalCents };
      return { content: `Recorded: ${item.title} (${formatCad(e.quote.totalCents)} incl. tax). The runner will be asked to approve.` };
    }
    default:
      return { content: `Unknown tool ${name}`, isError: true };
  }
}

function defaultCreateMessage(): CreateMessage {
  const key = config().ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set");
  const client = new Anthropic({ apiKey: key, timeout: 120_000 });
  return (params) => client.messages.create(params);
}

const MAX_TURNS = 8;

/**
 * Runs Claude with tools until it records a valid choice. The whole exchange
 * (including summarized thinking) is saved on the reward for replay.
 */
export async function runAgent(db: DB, rewardId: number, deps: AgentDeps = {}): Promise<AgentResult> {
  const [row] = await db
    .select({ event: rewardEvents, activity: activities, goal: goals })
    .from(rewardEvents)
    .innerJoin(activities, eq(rewardEvents.activityId, activities.id))
    .innerJoin(goals, eq(rewardEvents.goalId, goals.id))
    .where(eq(rewardEvents.id, rewardId));
  if (!row) return { ok: false, reason: `Reward ${rewardId} not found` };

  const [settings, user] = await Promise.all([getEffectiveSettings(db), getUser(db)]);
  const now = deps.now?.() ?? new Date();
  const ctx: Ctx = {
    db,
    event: row.event,
    activity: row.activity,
    goal: row.goal,
    budget: await budgetStatus(db, settings, now, user.timezone),
    provider: deps.provider ?? getProvider(settings),
    timeZone: user.timezone,
  };

  const model = config().ANTHROPIC_MODEL;
  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: `${user.name.split(" ")[0] || "The runner"} just finished a run that hit the goal "${row.goal.name}". Pick their reward (reward #${rewardId}).`,
    },
  ];
  const transcript = { model, system: SYSTEM_PROMPT, startedAt: now.toISOString(), finishedAt: "", messages, usage: { input: 0, output: 0 } };
  const save = () =>
    db.update(rewardEvents).set({ agentTranscript: { ...transcript, finishedAt: new Date().toISOString() } }).where(eq(rewardEvents.id, rewardId));

  let createMessage: CreateMessage;
  try {
    createMessage = deps.createMessage ?? defaultCreateMessage();
  } catch (err) {
    return { ok: false, reason: String(err instanceof Error ? err.message : err) };
  }

  try {
    for (let turn = 0; turn < MAX_TURNS && !ctx.chosen; turn++) {
      const res = await createMessage({
        model,
        max_tokens: 16_000,
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort: "medium" },
        messages,
      });
      transcript.usage.input += res.usage.input_tokens;
      transcript.usage.output += res.usage.output_tokens;
      messages.push({ role: "assistant", content: res.content });

      if (res.stop_reason === "refusal") {
        await save();
        return { ok: false, reason: "The model declined to choose a reward" };
      }
      const toolUses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      if (toolUses.length === 0 || res.stop_reason === "max_tokens") break;

      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const use of toolUses) {
        const out = await runTool(ctx, use.name, use.input);
        await logEvent(db, {
          kind: out.isError ? "agent.tool_error" : "agent.tool",
          rewardEventId: rewardId,
          message: `${use.name}(${JSON.stringify(use.input)})${out.isError ? ` → ${out.content}` : ""}`,
          data: { input: use.input, output: out.content },
        });
        results.push({ type: "tool_result", tool_use_id: use.id, content: out.content, ...(out.isError ? { is_error: true } : {}) });
      }
      // All results for one assistant turn go back in a single user message.
      messages.push({ role: "user", content: results });
      await save();
    }
  } catch (err) {
    await save();
    const reason = err instanceof Anthropic.APIError ? `Claude API error ${err.status}: ${err.message}` : String(err);
    return { ok: false, reason };
  }

  await save();
  if (!ctx.chosen) {
    const lastText = [...messages]
      .reverse()
      .flatMap((m) => (m.role === "assistant" && Array.isArray(m.content) ? m.content : []))
      .find((b): b is Anthropic.TextBlock => b.type === "text")?.text;
    return { ok: false, reason: lastText ? `Agent made no choice: ${lastText}` : "Agent made no choice" };
  }
  return { ok: true, ...ctx.chosen };
}
