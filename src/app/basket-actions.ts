"use server";

import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { challenges } from "@/db/schema";
import { requireAuth } from "@/lib/auth";
import { createBasketOrder } from "@/lib/basket";
import { challengeWindow } from "@/lib/challenges";
import { queueOrderRun } from "@/lib/pipeline-deps";
import { getUser } from "@/lib/settings";

/** "Check out now": order this week's basket without waiting for the week to end. */
export async function checkoutBasketNow(form: FormData) {
  await requireAuth();
  const db = await getDb();
  const user = await getUser(db);
  const [c] = await db.select().from(challenges).where(eq(challenges.id, Number(form.get("challengeId"))));
  const w = c ? challengeWindow(c, new Date(), user.timezone) : null;
  if (!c || !w) return;
  const id = await createBasketOrder(db, c.id, w.startKey);
  if (!id) return;
  queueOrderRun(db, id);
  redirect(`/orders/${id}`);
}
