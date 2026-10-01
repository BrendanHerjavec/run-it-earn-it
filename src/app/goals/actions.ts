"use server";

import { eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db";
import { challenges, goals, rewardEvents } from "@/db/schema";
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

const challengeSchema = z.object({
  name: z.string().trim().min(1).max(100),
  startsOn: z.string().regex(/^d{4}-d{2}-d{2}$/, "pick a start date"),
  lengthDays: z.coerce.number().int().min(1).max(60),
  repeats: z.boolean(),
  milestones: z
    .array(
      z.object({
        km: z.coerce.number().positive().max(500),
        tier: z.enum(TIERS),
        itemId: z.coerce.number().int().positive().nullable(),
      }),
    )
    .min(1, "add at least one milestone")
    .max(6),
});

/** A challenge plus one goal per milestone, e.g. 5 / 10 / 20 km in a week. */
export async function createChallenge(_prev: FormState, form: FormData): Promise<FormState> {
  await requireAuth();
  const milestones = [0, 1, 2, 3, 4, 5]
    .map((i) => ({ km: form.get(`km_${i}`), tier: form.get(`tier_${i}`), itemId: form.get(`item_${i}`) || null }))
    .filter((m) => m.km != null && String(m.km).trim() !== "");
  const parsed = challengeSchema.safeParse({
    name: form.get("name"),
    startsOn: form.get("startsOn"),
    lengthDays: form.get("lengthDays"),
    repeats: form.get("repeats") === "on",
    milestones,
  });
  if (!parsed.success) return { error: issues(parsed.error) };
  const c = parsed.data;
  const kms = c.milestones.map((m) => m.km);
  if (new Set(kms).size !== kms.length) return { error: "milestones must be different distances" };

  const db = await getDb();
  const [row] = await db.insert(challenges).values({ name: c.name, startsOn: c.startsOn, lengthDays: c.lengthDays, repeats: c.repeats }).returning();
  await db.insert(goals).values(
    c.milestones
      .sort((a, b) => a.km - b.km)
      .map((m) => ({
        name: `${c.name}: ${m.km} km`,
        type: "weekly_distance" as const,
        targetKm: m.km,
        rewardTier: m.tier,
        rewardItemId: m.itemId,
        challengeId: row.id,
      })),
  );
  revalidatePath("/goals");
  revalidatePath("/");
  return { ok: true };
}

export async function toggleChallenge(form: FormData) {
  await requireAuth();
  const id = Number(form.get("id"));
  const active = form.get("active") === "true";
  const db = await getDb();
  await db.update(challenges).set({ active }).where(eq(challenges.id, id));
  await db.update(goals).set({ active }).where(eq(goals.challengeId, id));
  revalidatePath("/goals");
  revalidatePath("/");
}

export async function deleteChallenge(form: FormData) {
  await requireAuth();
  const id = Number(form.get("id"));
  const db = await getDb();
  const ms = await db.select({ id: goals.id }).from(goals).where(eq(goals.challengeId, id));
  const used = ms.length
    ? await db.select({ id: rewardEvents.id }).from(rewardEvents).where(inArray(rewardEvents.goalId, ms.map((m) => m.id))).limit(1)
    : [];
  if (used.length) {
    // Past rewards point at these milestones: keep the rows, just retire them.
    await db.update(challenges).set({ active: false }).where(eq(challenges.id, id));
    await db.update(goals).set({ active: false }).where(eq(goals.challengeId, id));
  } else {
    await db.delete(goals).where(eq(goals.challengeId, id));
    await db.delete(challenges).where(eq(challenges.id, id));
  }
  revalidatePath("/goals");
  revalidatePath("/");
}
