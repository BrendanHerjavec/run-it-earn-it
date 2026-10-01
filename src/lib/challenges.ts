import { and, asc, eq, gte, inArray, lt } from "drizzle-orm";
import type { DB } from "@/db";
import { activities, challenges, goals, rewardEvents, wishlistItems, type Challenge } from "@/db/schema";
import { distanceBetweenM } from "./stats";
import { addDays, daysBetween, localDateKey, localDateStart } from "./time";

export type ChallengeWindow = { index: number; startKey: string; endKey: string; start: Date; end: Date };

/**
 * The challenge window containing `at`, or null if `at` is outside every window
 * (before the start, or after the end of a non-repeating challenge).
 */
export function challengeWindow(c: Pick<Challenge, "startsOn" | "lengthDays" | "repeats">, at: Date, timeZone: string): ChallengeWindow | null {
  const len = Math.max(1, c.lengthDays);
  const day = daysBetween(c.startsOn, localDateKey(at, timeZone));
  if (day < 0) return null;
  const index = Math.floor(day / len);
  if (index > 0 && !c.repeats) return null;
  const startKey = addDays(c.startsOn, index * len);
  const endKey = addDays(c.startsOn, (index + 1) * len);
  return { index, startKey, endKey, start: localDateStart(startKey, timeZone), end: localDateStart(endKey, timeZone) };
}

export type ChallengeProgress = {
  challenge: Challenge;
  window: ChallengeWindow | null;
  totalM: number;
  milestones: {
    goalId: number;
    km: number;
    tier: string;
    itemTitle: string | null;
    active: boolean;
    unlocked: boolean;
    rewardEventId: number | null;
    rewardStatus: string | null;
  }[];
};

const LIVE = ["pending_agent", "awaiting_approval", "approved", "checking_out", "completed"] as const;

/** Progress of every active challenge at `now`, for the dashboard and the agent. */
export async function challengeProgress(db: DB, now: Date, timeZone: string, onlyChallengeId?: number): Promise<ChallengeProgress[]> {
  const list = await db
    .select()
    .from(challenges)
    .where(onlyChallengeId ? eq(challenges.id, onlyChallengeId) : eq(challenges.active, true))
    .orderBy(asc(challenges.id));
  const out: ChallengeProgress[] = [];
  for (const c of list) {
    const w = challengeWindow(c, now, timeZone);
    const ms = await db
      .select({ goal: goals, itemTitle: wishlistItems.title })
      .from(goals)
      .leftJoin(wishlistItems, eq(goals.rewardItemId, wishlistItems.id))
      .where(eq(goals.challengeId, c.id))
      .orderBy(asc(goals.targetKm));
    const totalM = w ? await distanceBetweenM(db, w.start, now < w.end ? now : w.end) : 0;
    const ids = ms.map((m) => m.goal.id);
    const paid =
      w && ids.length
        ? await db
            .select({ goalId: rewardEvents.goalId, id: rewardEvents.id, status: rewardEvents.status })
            .from(rewardEvents)
            .innerJoin(activities, eq(rewardEvents.activityId, activities.id))
            .where(
              and(
                inArray(rewardEvents.goalId, ids),
                inArray(rewardEvents.status, [...LIVE]),
                gte(activities.startTime, w.start),
                lt(activities.startTime, w.end),
              ),
            )
        : [];
    const inWindow = new Map(paid.filter((p) => p.goalId != null).map((p) => [p.goalId!, { id: p.id, status: p.status }]));
    out.push({
      challenge: c,
      window: w,
      totalM,
      milestones: ms.map(({ goal, itemTitle }) => ({
        goalId: goal.id,
        km: goal.targetKm ?? 0,
        tier: goal.rewardTier,
        itemTitle,
        active: goal.active,
        unlocked: inWindow.has(goal.id),
        rewardEventId: inWindow.get(goal.id)?.id ?? null,
        rewardStatus: inWindow.get(goal.id)?.status ?? null,
      })),
    });
  }
  return out;
}
