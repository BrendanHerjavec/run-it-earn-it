import { and, desc, gte, inArray, lte, sql } from "drizzle-orm";
import type { DB } from "@/db";
import { activities, spendLedger } from "@/db/schema";
import { localDateKey, startOfLocalDay, startOfLocalWeek } from "./time";
import type { EffectiveSettings } from "./settings";

export const RUN_TYPES = ["Run", "TrailRun"];

/** Total metres of valid (unflagged) runs since the start of the local week containing `at`. */
export async function weeklyDistanceM(db: DB, at: Date, timeZone: string): Promise<number> {
  const since = startOfLocalWeek(at, timeZone);
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${activities.distanceM}), 0)` })
    .from(activities)
    .where(
      and(
        gte(activities.startTime, since),
        lte(activities.startTime, at),
        inArray(activities.sportType, RUN_TYPES),
        sql`${activities.flagged} = false`,
      ),
    );
  return Number(row?.total ?? 0);
}

/** Consecutive local days (ending today or yesterday) with at least one valid run. */
export async function runStreakDays(db: DB, now: Date, timeZone: string): Promise<number> {
  const rows = await db
    .select({ startTime: activities.startTime })
    .from(activities)
    .where(and(inArray(activities.sportType, RUN_TYPES), sql`${activities.flagged} = false`))
    .orderBy(desc(activities.startTime))
    .limit(400);
  const days = new Set(rows.map((r) => localDateKey(r.startTime, timeZone)));
  let streak = 0;
  const cursor = new Date(now);
  if (!days.has(localDateKey(cursor, timeZone))) cursor.setUTCDate(cursor.getUTCDate() - 1);
  while (days.has(localDateKey(cursor, timeZone))) {
    streak++;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return streak;
}

export type BudgetStatus = {
  maxOrderCents: number;
  dailyCapCents: number;
  weeklyCapCents: number;
  spentTodayCents: number;
  spentThisWeekCents: number;
  remainingDailyCents: number;
  remainingWeeklyCents: number;
  /** The most a single reward may cost right now: min(per-order, daily left, weekly left). */
  availableForNextOrderCents: number;
};

async function spentSince(db: DB, since: Date): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${spendLedger.amountCents}), 0)` })
    .from(spendLedger)
    .where(and(gte(spendLedger.createdAt, since), inArray(spendLedger.kind, ["reserved", "settled"])));
  return Number(row?.total ?? 0);
}

export async function budgetStatus(db: DB, s: EffectiveSettings, now: Date, timeZone: string): Promise<BudgetStatus> {
  const [today, week] = await Promise.all([
    spentSince(db, startOfLocalDay(now, timeZone)),
    spentSince(db, startOfLocalWeek(now, timeZone)),
  ]);
  const remainingDailyCents = Math.max(0, s.maxDailyCents - today);
  const remainingWeeklyCents = Math.max(0, s.maxWeeklyCents - week);
  return {
    maxOrderCents: s.maxOrderCents,
    dailyCapCents: s.maxDailyCents,
    weeklyCapCents: s.maxWeeklyCents,
    spentTodayCents: today,
    spentThisWeekCents: week,
    remainingDailyCents,
    remainingWeeklyCents,
    availableForNextOrderCents: Math.min(s.maxOrderCents, remainingDailyCents, remainingWeeklyCents),
  };
}
