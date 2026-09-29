import { and, eq, lte } from "drizzle-orm";
import type { DB } from "@/db";
import { activities, rewardEvents, users, wishlistItems, type Activity } from "@/db/schema";
import { config } from "./config";
import { logEvent } from "./events";
import { evaluateGoals, pickGoal, sanityCheck } from "./rules";
import { getEffectiveSettings, getUser } from "./settings";
import { budgetStatus } from "./stats";
import { fetchActivity as fetchFromStrava, getAccessToken, type StravaActivity, type StravaWebhookEvent } from "./strava";
import { TIER_MAX_CENTS, TIERS } from "./tiers";

export type Outcome =
  | { status: "ignored"; reason: string; activityId?: number }
  | { status: "flagged"; reason: string; activityId: number }
  | { status: "no_goal"; reason: string; activityId: number }
  | { status: "duplicate"; reason: string; activityId: number; rewardEventId?: number }
  | { status: "skipped_budget"; reason: string; activityId: number; rewardEventId: number }
  | { status: "reward_created"; reason: string; activityId: number; rewardEventId: number };

export type PipelineDeps = {
  /** Injected in tests; defaults to the real Strava API with the stored user tokens. */
  fetchActivity?: (db: DB, stravaId: number) => Promise<StravaActivity>;
  /** Called after a RewardEvent is created in pending_agent; production starts the agent here. */
  onRewardCreated?: (db: DB, rewardEventId: number) => Promise<void>;
  /** "Sync runs": rewards buy automatically after a countdown instead of waiting for Approve. */
  autoApprove?: boolean;
};

async function defaultFetch(db: DB, stravaId: number): Promise<StravaActivity> {
  const user = await getUser(db);
  return fetchFromStrava(await getAccessToken(db, user), stravaId);
}

/** Entry point for Strava webhook POSTs (after the 200 has been sent). */
export async function handleWebhookEvent(db: DB, event: StravaWebhookEvent, deps: PipelineDeps = {}): Promise<Outcome> {
  const user = await getUser(db);

  if (event.object_type === "athlete" && event.updates?.authorized === "false") {
    if (user.stravaAthleteId === event.owner_id) {
      await db.update(users).set({ stravaAthleteId: null, stravaTokensEnc: null }).where(eq(users.id, user.id));
    }
    await logEvent(db, { kind: "strava.deauthorized", message: `Athlete ${event.owner_id} revoked access`, data: event });
    return { status: "ignored", reason: "athlete deauthorized" };
  }

  if (event.object_type !== "activity" || event.aspect_type !== "create") {
    return { status: "ignored", reason: `${event.object_type}:${event.aspect_type} not handled` };
  }
  if (!user.stravaAthleteId || user.stravaAthleteId !== event.owner_id) {
    await logEvent(db, { kind: "strava.unknown_owner", message: `Event for athlete ${event.owner_id} ignored`, data: event });
    return { status: "ignored", reason: "event is not for the connected athlete" };
  }

  // Webhook retries: if we already stored this activity, don't hit Strava again.
  const [existing] = await db.select().from(activities).where(eq(activities.stravaId, event.object_id));
  if (existing) return processActivity(db, existing, deps);

  const raw = await (deps.fetchActivity ?? defaultFetch)(db, event.object_id);
  const { activity } = await storeActivity(db, raw, "strava");
  return processActivity(db, activity, deps);
}

/**
 * Insert (or find) the activity row. Safe to call repeatedly for the same run.
 * Strava and simulated runs are keyed by numeric `stravaId`; other sources
 * (COROS) pass a text `externalId` such as "coros:470000000000000001".
 */
export async function storeActivity(db: DB, a: StravaActivity, source: "strava" | "simulated" | "coros", externalId?: string) {
  const sanity = sanityCheck(
    { sportType: a.sport_type ?? a.type ?? "Unknown", averageSpeedMps: a.average_speed },
    config().MAX_RUN_SPEED_KMH,
  );
  const [inserted] = await db
    .insert(activities)
    .values({
      stravaId: externalId ? null : a.id,
      externalId: externalId ?? null,
      source,
      name: a.name ?? "",
      sportType: a.sport_type ?? a.type ?? "Unknown",
      distanceM: a.distance,
      movingTimeS: a.moving_time,
      averageSpeedMps: a.average_speed,
      startTime: new Date(a.start_date),
      polyline: a.map?.polyline || a.map?.summary_polyline || null,
      flagged: !sanity.ok && sanity.flag,
      flagReason: !sanity.ok && sanity.flag ? sanity.reason : null,
      raw: a,
    })
    .onConflictDoNothing({ target: externalId ? activities.externalId : activities.stravaId })
    .returning();
  if (inserted) {
    await logEvent(db, {
      kind: "activity.stored",
      activityId: inserted.id,
      message: `${source} activity ${externalId ?? a.id}: ${a.sport_type} ${(a.distance / 1000).toFixed(2)} km`,
    });
    return { activity: inserted, created: true };
  }
  const [row] = await db
    .select()
    .from(activities)
    .where(externalId ? eq(activities.externalId, externalId) : eq(activities.stravaId, a.id));
  return { activity: row, created: false };
}

/** Rules engine + guardrails for one stored activity. Creates at most one RewardEvent, ever. */
export async function processActivity(db: DB, activity: Activity, deps: PipelineDeps = {}): Promise<Outcome> {
  const [prior] = await db.select().from(rewardEvents).where(eq(rewardEvents.activityId, activity.id));
  if (prior) {
    return { status: "duplicate", reason: "Reward already exists for this activity", activityId: activity.id, rewardEventId: prior.id };
  }

  const sanity = sanityCheck(activity, config().MAX_RUN_SPEED_KMH);
  if (!sanity.ok) {
    await logEvent(db, { kind: sanity.flag ? "activity.flagged" : "activity.rejected", activityId: activity.id, message: sanity.reason });
    return sanity.flag
      ? { status: "flagged", reason: sanity.reason, activityId: activity.id }
      : { status: "ignored", reason: sanity.reason, activityId: activity.id };
  }

  const user = await getUser(db);
  const hits = await evaluateGoals(db, activity, user.timezone);
  const hit = pickGoal(hits);
  if (!hit) {
    await logEvent(db, { kind: "rules.no_goal", activityId: activity.id, message: "No active goal met" });
    return { status: "no_goal", reason: "No active goal met", activityId: activity.id };
  }
  await logEvent(db, {
    kind: "rules.goal_met",
    activityId: activity.id,
    message: `${hit.goal.name}: ${hit.detail}`,
    data: { hits: hits.map((h) => ({ goalId: h.goal.id, name: h.goal.name, detail: h.detail })), chosen: hit.goal.id },
  });

  // Budget guardrail: is there at least one wishlist item this goal could pay for right now?
  const settings = await getEffectiveSettings(db);
  const budget = await budgetStatus(db, settings, new Date(), user.timezone);
  const tierIdx = TIERS.indexOf(hit.goal.rewardTier);
  const allowedTiers = TIERS.slice(0, tierIdx + 1);
  const ceiling = Math.min(budget.availableForNextOrderCents, TIER_MAX_CENTS[hit.goal.rewardTier]);
  const affordableInTier = (
    await db
      .select({ tier: wishlistItems.tier })
      .from(wishlistItems)
      .where(and(eq(wishlistItems.active, true), lte(wishlistItems.expectedPriceCents, ceiling)))
  ).some((r) => allowedTiers.includes(r.tier));

  const status = affordableInTier ? "pending_agent" : "skipped_budget";
  const [created] = await db
    .insert(rewardEvents)
    .values({
      activityId: activity.id,
      goalId: hit.goal.id,
      status,
      autoApprove: deps.autoApprove ?? false,
      failureReason: affordableInTier ? null : `No wishlist item fits: ${(ceiling / 100).toFixed(2)} CAD available for a ${hit.goal.rewardTier} reward`,
    })
    .onConflictDoNothing({ target: rewardEvents.activityId })
    .returning();

  if (!created) {
    // Lost a race with a concurrent webhook delivery for the same activity.
    const [row] = await db.select().from(rewardEvents).where(eq(rewardEvents.activityId, activity.id));
    return { status: "duplicate", reason: "Reward already exists for this activity", activityId: activity.id, rewardEventId: row?.id };
  }

  await logEvent(db, {
    kind: "reward.created",
    rewardEventId: created.id,
    activityId: activity.id,
    message: `Reward event ${created.id} → ${status}`,
    data: { goal: hit.goal.name, budget },
  });

  if (status === "skipped_budget") {
    return { status: "skipped_budget", reason: created.failureReason ?? "", activityId: activity.id, rewardEventId: created.id };
  }
  await deps.onRewardCreated?.(db, created.id);
  return { status: "reward_created", reason: hit.detail, activityId: activity.id, rewardEventId: created.id };
}
