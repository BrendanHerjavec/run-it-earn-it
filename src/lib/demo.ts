import { eq, inArray, or } from "drizzle-orm";
import type { DB } from "@/db";
import { activities, eventLog, rewardEvents, spendLedger } from "@/db/schema";

/** Remove every simulated run and everything it caused, so real totals are clean. */
export async function deleteDemoData(db: DB): Promise<{ runs: number; rewards: number }> {
  const acts = await db.select({ id: activities.id }).from(activities).where(eq(activities.source, "simulated"));
  const actIds = acts.map((a) => a.id);
  if (!actIds.length) return { runs: 0, rewards: 0 };
  const rewards = await db.select({ id: rewardEvents.id }).from(rewardEvents).where(inArray(rewardEvents.activityId, actIds));
  const rewardIds = rewards.map((r) => r.id);
  await db.transaction(async (tx) => {
    if (rewardIds.length) await tx.delete(spendLedger).where(inArray(spendLedger.rewardEventId, rewardIds));
    await tx
      .delete(eventLog)
      .where(rewardIds.length ? or(inArray(eventLog.activityId, actIds), inArray(eventLog.rewardEventId, rewardIds)) : inArray(eventLog.activityId, actIds));
    if (rewardIds.length) await tx.delete(rewardEvents).where(inArray(rewardEvents.id, rewardIds));
    await tx.delete(activities).where(inArray(activities.id, actIds));
  });
  return { runs: actIds.length, rewards: rewardIds.length };
}
