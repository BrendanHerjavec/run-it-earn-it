import { and, eq, gte, inArray, lt } from "drizzle-orm";
import type { DB } from "@/db";
import { activities, challenges, goals, rewardEvents, type Activity, type Goal } from "@/db/schema";
import { challengeWindow } from "./challenges";
import { closestApproachM, decodePolyline, routePassesWithin } from "./geo";
import { distanceBetweenM, RUN_TYPES } from "./stats";
import { startOfLocalWeek } from "./time";
import { TIERS } from "./tiers";

/** Statuses that mean "this goal already paid out (or is paying out)". Failed/skipped/rejected don't count. */
const LIVE_STATUSES = ["pending_agent", "awaiting_approval", "approved", "checking_out", "completed"] as const;

export type SanityResult = { ok: true } | { ok: false; reason: string; flag: boolean };

/** Guardrail: only real runs earn rewards. Suspiciously fast "runs" are flagged for review. */
export function sanityCheck(a: { sportType: string; averageSpeedMps: number }, maxKmh: number): SanityResult {
  if (!RUN_TYPES.includes(a.sportType)) {
    return { ok: false, reason: `Activity type ${a.sportType} is not a run`, flag: false };
  }
  const kmh = a.averageSpeedMps * 3.6;
  if (kmh > maxKmh) {
    return {
      ok: false,
      reason: `Average speed ${kmh.toFixed(1)} km/h is above the ${maxKmh} km/h limit (bike or car?)`,
      flag: true,
    };
  }
  return { ok: true };
}

export type GoalHit = { goal: Goal; detail: string };

async function goalAlreadyPaid(db: DB, goalId: number, since?: Date, until?: Date): Promise<boolean> {
  const conds = [eq(rewardEvents.goalId, goalId), inArray(rewardEvents.status, [...LIVE_STATUSES])];
  if (since) conds.push(gte(activities.startTime, since));
  if (until) conds.push(lt(activities.startTime, until));
  const rows = await db
    .select({ id: rewardEvents.id })
    .from(rewardEvents)
    .innerJoin(activities, eq(rewardEvents.activityId, activities.id))
    .where(and(...conds))
    .limit(1);
  return rows.length > 0;
}

/**
 * Which active goals does this (already stored, sanity-checked) activity satisfy?
 *  - single_run_distance: every qualifying run earns it.
 *  - weekly_distance: earned by the run that crosses the target, once per local week.
 *  - quest: earned the first time a route passes within the radius (one-time).
 */
export async function evaluateGoals(db: DB, activity: Activity, timeZone: string): Promise<GoalHit[]> {
  const active = await db.select().from(goals).where(eq(goals.active, true));
  const challengeById = new Map((await db.select().from(challenges)).map((c) => [c.id, c]));
  const hits: GoalHit[] = [];
  const km = activity.distanceM / 1000;
  let route: ReturnType<typeof decodePolyline> | null = null;

  for (const goal of active) {
    if (goal.type === "single_run_distance" && goal.targetKm != null) {
      if (km >= goal.targetKm) hits.push({ goal, detail: `${km.toFixed(2)} km ≥ ${goal.targetKm} km in one run` });
    } else if (goal.type === "weekly_distance" && goal.targetKm != null) {
      // A challenge milestone uses its challenge's window; a plain weekly goal uses the calendar week.
      let from: Date;
      let to: Date;
      let label: string;
      if (goal.challengeId != null) {
        const c = challengeById.get(goal.challengeId);
        const w = c?.active ? challengeWindow(c, activity.startTime, timeZone) : null;
        if (!c || !w) continue;
        [from, to, label] = [w.start, w.end, `${c.name}`];
      } else {
        from = startOfLocalWeek(activity.startTime, timeZone);
        to = new Date(from.getTime() + 8 * 86_400_000);
        label = "Weekly total";
      }
      const totalKm = (await distanceBetweenM(db, from, activity.startTime)) / 1000;
      const beforeKm = totalKm - km;
      if (beforeKm < goal.targetKm && totalKm >= goal.targetKm && !(await goalAlreadyPaid(db, goal.id, from, to))) {
        hits.push({ goal, detail: `${label}: ${totalKm.toFixed(2)} km, unlocked the ${goal.targetKm} km milestone` });
      }
    } else if (goal.type === "quest" && goal.lat != null && goal.lng != null) {
      route ??= decodePolyline(activity.polyline);
      const radius = goal.radiusM ?? 75;
      if (routePassesWithin(route, [goal.lat, goal.lng], radius) && !(await goalAlreadyPaid(db, goal.id))) {
        const d = closestApproachM(route, [goal.lat, goal.lng]);
        hits.push({ goal, detail: `Passed within ${Math.round(d ?? 0)} m of ${goal.name} (radius ${radius} m)` });
      }
    }
  }
  return hits;
}

/**
 * Which hits pay out for one activity:
 *  - every challenge milestone crossed (a big run can unlock 5 K and 10 K at once);
 *  - plus the single best of the other goals (highest tier; quests win ties).
 */
export function selectRewards(hits: GoalHit[]): GoalHit[] {
  const milestones = hits.filter((h) => h.goal.challengeId != null).sort((a, b) => (a.goal.targetKm ?? 0) - (b.goal.targetKm ?? 0));
  const best = pickGoal(hits.filter((h) => h.goal.challengeId == null));
  return best ? [...milestones, best] : milestones;
}

/** Highest tier; quests win ties (they're the fun ones). */
export function pickGoal(hits: GoalHit[]): GoalHit | null {
  if (hits.length === 0) return null;
  const typeRank = { quest: 2, weekly_distance: 1, single_run_distance: 0 } as const;
  return [...hits].sort(
    (a, b) =>
      TIERS.indexOf(b.goal.rewardTier) - TIERS.indexOf(a.goal.rewardTier) || typeRank[b.goal.type] - typeRank[a.goal.type],
  )[0];
}
