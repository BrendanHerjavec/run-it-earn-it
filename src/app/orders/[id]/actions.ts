"use server";

import { getDb } from "@/db";
import { requireAuth } from "@/lib/auth";
import { cancelPendingOrder, confirmOrderPurchase, reopenBasket, resumeOrder } from "@/lib/basket";
import { parseDollarsToCents } from "@/lib/format";

export type ActionResult = { ok: boolean; error?: string };

export async function cancelOrderAction(id: number): Promise<ActionResult> {
  await requireAuth();
  const ok = await cancelPendingOrder(await getDb(), id);
  return ok ? { ok } : { ok, error: "Too late to cancel: checkout has started" };
}

export async function confirmOrderAction(id: number, placed: boolean, total?: string, orderNumber?: string): Promise<ActionResult> {
  await requireAuth();
  const ok = await confirmOrderPurchase(await getDb(), id, {
    placed,
    totalCents: parseDollarsToCents(total ?? null) ?? undefined,
    orderNumber: orderNumber?.trim().slice(0, 64) || undefined,
  });
  return ok ? { ok } : { ok, error: "This order isn't waiting at checkout" };
}

export async function resumeOrderAction(id: number): Promise<ActionResult> {
  await requireAuth();
  const ok = await resumeOrder(await getDb(), id, "I've handled it in the browser");
  return ok ? { ok } : { ok, error: "This checkout isn't waiting for you" };
}

export async function reopenOrderAction(id: number): Promise<ActionResult> {
  await requireAuth();
  const ok = await reopenBasket(await getDb(), id);
  return ok ? { ok } : { ok, error: "Only a failed or not-bought order can go back to the basket" };
}
