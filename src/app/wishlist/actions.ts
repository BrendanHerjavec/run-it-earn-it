"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db";
import { rewardEvents, wishlistItems } from "@/db/schema";
import { requireAuth } from "@/lib/auth";
import { TIERS } from "@/lib/tiers";
import { parseDollarsToCents } from "@/lib/format";

const itemSchema = z.object({
  title: z.string().trim().min(1).max(200),
  productUrl: z
    .string()
    .trim()
    .url()
    .refine((u) => /^https?:\/\//i.test(u), "Must be an http(s) URL"),
  expectedPriceCents: z.number().int().positive(),
  tier: z.enum(TIERS),
  notes: z.string().trim().max(1000),
  active: z.boolean(),
});

export type FormState = { error?: string; ok?: boolean };

function parse(form: FormData) {
  return itemSchema.safeParse({
    title: form.get("title"),
    productUrl: form.get("productUrl"),
    expectedPriceCents: parseDollarsToCents(form.get("expectedPrice")),
    tier: form.get("tier"),
    notes: form.get("notes") ?? "",
    active: form.get("active") === "on",
  });
}

export async function saveItem(_prev: FormState, form: FormData): Promise<FormState> {
  await requireAuth();
  const parsed = parse(form);
  if (!parsed.success) {
    return { error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  }
  const db = await getDb();
  const id = Number(form.get("id") || 0);
  if (id) {
    await db.update(wishlistItems).set(parsed.data).where(eq(wishlistItems.id, id));
  } else {
    await db.insert(wishlistItems).values(parsed.data);
  }
  revalidatePath("/wishlist");
  return { ok: true };
}

export async function deleteItem(form: FormData) {
  await requireAuth();
  const id = Number(form.get("id"));
  const db = await getDb();
  const used = await db.select({ id: rewardEvents.id }).from(rewardEvents).where(eq(rewardEvents.chosenItemId, id)).limit(1);
  if (used.length) {
    // Past rewards point at this item, so keep the row and just retire it.
    await db.update(wishlistItems).set({ active: false }).where(eq(wishlistItems.id, id));
  } else {
    await db.delete(wishlistItems).where(eq(wishlistItems.id, id));
  }
  revalidatePath("/wishlist");
}
