import type Anthropic from "@anthropic-ai/sdk";
import { asc, eq, or } from "drizzle-orm";
import type { DB } from "@/db";
import { activities, eventLog, goals, rewardEvents, wishlistItems, type RewardStatus } from "@/db/schema";
import type { CheckoutStatus } from "./providers";

export type TranscriptStep =
  | { kind: "thinking"; text: string }
  | { kind: "text"; text: string }
  | { kind: "tool_call"; name: string; input: unknown }
  | { kind: "tool_result"; content: string; isError: boolean };

export type RewardView = {
  id: number;
  status: RewardStatus;
  failureReason: string | null;
  agentMessage: string | null;
  item: { id: number; title: string; priceCents: number; tier: string; productUrl: string } | null;
  quotedTotalCents: number | null;
  maxSpendCents: number | null;
  totalChargedCents: number | null;
  receipt: unknown;
  provider: string | null;
  liveViewUrl: string | null;
  approvedVia: string | null;
  autoApprove: boolean;
  autoApproveAt: string | null;
  checkout: CheckoutStatus | null;
  transcript: { model: string; steps: TranscriptStep[]; usage?: { input: number; output: number } } | null;
  log: { id: number; at: string; kind: string; message: string }[];
  activity: {
    distanceM: number;
    movingTimeS: number;
    sportType: string;
    name: string;
    startTime: string;
    polyline: string | null;
    source: string;
  };
  goal: { name: string; type: string; rewardTier: string } | null;
  /** Other rewards unlocked by the same run (e.g. 5 K and 10 K milestones together). */
  siblings: { id: number; goalName: string | null; status: string; itemTitle: string | null }[];
};

function flattenTranscript(raw: unknown): RewardView["transcript"] {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as { model: string; messages: Anthropic.MessageParam[]; usage?: { input: number; output: number } };
  const steps: TranscriptStep[] = [];
  for (const m of t.messages ?? []) {
    if (typeof m.content === "string") {
      if (m.role === "assistant") steps.push({ kind: "text", text: m.content });
      continue;
    }
    for (const b of m.content) {
      if (b.type === "thinking" && b.thinking) steps.push({ kind: "thinking", text: b.thinking });
      else if (b.type === "text" && b.text && m.role === "assistant") steps.push({ kind: "text", text: b.text });
      else if (b.type === "tool_use") steps.push({ kind: "tool_call", name: b.name, input: b.input });
      else if (b.type === "tool_result")
        steps.push({ kind: "tool_result", content: typeof b.content === "string" ? b.content : JSON.stringify(b.content), isError: !!b.is_error });
    }
  }
  return { model: t.model, steps, usage: t.usage };
}

export async function getRewardView(db: DB, id: number): Promise<RewardView | null> {
  const [row] = await db
    .select({ event: rewardEvents, activity: activities, goal: goals, item: wishlistItems })
    .from(rewardEvents)
    .innerJoin(activities, eq(rewardEvents.activityId, activities.id))
    .leftJoin(goals, eq(rewardEvents.goalId, goals.id))
    .leftJoin(wishlistItems, eq(rewardEvents.chosenItemId, wishlistItems.id))
    .where(eq(rewardEvents.id, id));
  if (!row) return null;
  const { event: e, activity: a, goal: g, item: i } = row;
  const siblings = await db
    .select({ id: rewardEvents.id, goalName: goals.name, status: rewardEvents.status, itemTitle: wishlistItems.title })
    .from(rewardEvents)
    .leftJoin(goals, eq(rewardEvents.goalId, goals.id))
    .leftJoin(wishlistItems, eq(rewardEvents.chosenItemId, wishlistItems.id))
    .where(eq(rewardEvents.activityId, a.id))
    .orderBy(asc(rewardEvents.id));
  const log = await db
    .select()
    .from(eventLog)
    .where(or(eq(eventLog.rewardEventId, id), eq(eventLog.activityId, a.id)))
    .orderBy(asc(eventLog.id));

  return {
    id: e.id,
    status: e.status,
    failureReason: e.failureReason,
    agentMessage: e.agentMessage,
    item: i ? { id: i.id, title: i.title, priceCents: i.expectedPriceCents, tier: i.tier, productUrl: i.productUrl } : null,
    quotedTotalCents: e.quotedTotalCents,
    maxSpendCents: e.maxSpendCents,
    totalChargedCents: e.totalChargedCents,
    receipt: e.receipt,
    provider: e.provider,
    liveViewUrl: e.liveViewUrl,
    approvedVia: e.approvedVia,
    autoApprove: e.autoApprove,
    autoApproveAt: e.autoApproveAt?.toISOString() ?? null,
    checkout: (e.checkoutState as CheckoutStatus | null) ?? null,
    transcript: flattenTranscript(e.agentTranscript),
    log: log.map((l) => ({ id: l.id, at: l.createdAt.toISOString(), kind: l.kind, message: l.message })),
    activity: {
      distanceM: a.distanceM,
      movingTimeS: a.movingTimeS,
      sportType: a.sportType,
      name: a.name,
      startTime: a.startTime.toISOString(),
      polyline: a.polyline,
      source: a.source,
    },
    goal: g ? { name: g.name, type: g.type, rewardTier: g.rewardTier } : null,
    siblings: siblings.filter((x) => x.id !== e.id),
  };
}
