"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db";
import { goals, rewardEvents } from "@/db/schema";
import { requireAuth } from "@/lib/auth";
import { TIERS } from "@/lib/tiers";

export type FormState = { error?: string; ok?: boolean };

const distanceSchema = z.object({
  name: z.string().trim().min(1).max(100),
  type: z.enum(["single_run_distance", "weekly_distance"]),
  targetKm: z.coerce.number().positive().max(500),
  rewardTier: z.enum(TIERS),
});

const questSchema = z.object({
  name: z.string().trim().min(1).max(100),
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  radiusM: z.coerce.number().int().min(10).max(2000),
  rewardTier: z.enum(TIERS),
});

function issues(e: z.ZodError) {
  return e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
}

export async function createDistanceGoal(_prev: FormState, form: FormData): Promise<FormState> {
  await requireAuth();
  const parsed = distanceSchema.safeParse(Object.fromEntries(form));
  if (!parsed.success) return { error: issues(parsed.error) };
  const db = await getDb();
  await db.insert(goals).values(parsed.data);
  revalidatePath("/goals");
  return { ok: true };
}

export async function createQuest(_prev: FormState, form: FormData): Promise<FormState> {
  await requireAuth();
  const parsed = questSchema.safeParse(Object.fromEntries(form));
  if (!parsed.success) return { error: issues(parsed.error) };
  const db = await getDb();
  await db.insert(goals).values({ ...parsed.data, type: "quest" });
  revalidatePath("/goals");
  return { ok: true };
}

export async function toggleGoal(form: FormData) {
  await requireAuth();
  const id = Number(form.get("id"));
  const active = form.get("active") === "true";
  const db = await getDb();
  await db.update(goals).set({ active }).where(eq(goals.id, id));
  revalidatePath("/goals");
}

export async function deleteGoal(form: FormData) {
  await requireAuth();
  const id = Number(form.get("id"));
  const db = await getDb();
  const used = await db.select({ id: rewardEvents.id }).from(rewardEvents).where(eq(rewardEvents.goalId, id)).limit(1);
  if (used.length) {
    await db.update(goals).set({ active: false }).where(eq(goals.id, id));
  } else {
    await db.delete(goals).where(eq(goals.id, id));
  }
  revalidatePath("/goals");
}
