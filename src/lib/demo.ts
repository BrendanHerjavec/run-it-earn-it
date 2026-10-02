import { eq, inArray, or } from "drizzle-orm";
import type { DB } from "@/db";
import { activities, eventLog, orders, rewardEvents, spendLedger } from "@/db/schema";

/**
 * Remove every simulated run and everything it caused (rewards, basket orders
 * made of them, ledger rows, log lines), so real totals and this week's basket
 * are clean. Orders that also contain real rewards are kept.
 */
export async function deleteDemoData(db: DB): Promise<{ runs: number; rewards: number; orders: number }> {
  const acts = await db.select({ id: activities.id }).from(activities).where(eq(activities.source, "simulated"));
  const actIds = acts.map((a) => a.id);
  if (!actIds.length) return { runs: 0, rewards: 0, orders: 0 };
  const rewards = await db.select({ id: rewardEvents.id, orderId: rewardEvents.orderId }).from(rewardEvents).where(inArray(rewardEvents.activityId, actIds));
  const rewardIds = rewards.map((r) => r.id);

  // Orders that consist only of demo rewards go too.
  const candidateOrders = [...new Set(rewards.map((r) => r.orderId).filter((x): x is number => x != null))];
  const orderIds: number[] = [];
  for (const id of candidateOrders) {
    const members = await db.select({ id: rewardEvents.id }).from(rewardEvents).where(eq(rewardEvents.orderId, id));
    if (members.every((m) => rewardIds.includes(m.id))) orderIds.push(id);
  }

  await db.transaction(async (tx) => {
    if (rewardIds.length) await tx.delete(spendLedger).where(inArray(spendLedger.rewardEventId, rewardIds));
    if (orderIds.length) await tx.delete(spendLedger).where(inArray(spendLedger.orderId, orderIds));
    const logConds = [inArray(eventLog.activityId, actIds)];
    if (rewardIds.length) logConds.push(inArray(eventLog.rewardEventId, rewardIds));
    if (orderIds.length) logConds.push(inArray(eventLog.orderId, orderIds));
    await tx.delete(eventLog).where(or(...logConds));
    // Real rewards that shared a kept order stay; demo rewards are removed.
    if (rewardIds.length) await tx.delete(rewardEvents).where(inArray(rewardEvents.id, rewardIds));
    if (orderIds.length) await tx.delete(orders).where(inArray(orders.id, orderIds));
    await tx.delete(activities).where(inArray(activities.id, actIds));
  });
  return { runs: actIds.length, rewards: rewardIds.length, orders: orderIds.length };
}


