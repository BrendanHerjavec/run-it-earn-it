"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db";
import { goals } from "@/db/schema";
import { requireAuth } from "@/lib/auth";
import { config } from "@/lib/config";
import { logEvent } from "@/lib/events";
import { processActivity, storeActivity, type Outcome } from "@/lib/pipeline";
import { pipelineDeps } from "@/lib/pipeline-deps";
import { buildSimulatedActivity } from "@/lib/simulate";

const schema = z.object({
  distanceKm: z.coerce.number().positive().max(100),
  paceMin: z.coerce.number().int().min(1).max(20),
  paceSec: z.coerce.number().int().min(0).max(59),
  sportType: z.enum(["Run", "TrailRun", "Ride", "Walk"]),
  questId: z.coerce.number().int().optional(),
});

export type SimulateState = { outcome?: Outcome; error?: string };

export async function simulateRun(_prev: SimulateState, form: FormData): Promise<SimulateState> {
  await requireAuth();
  if (!config().DEMO_TOOLS_ENABLED) return { error: "Demo tools are disabled (DEMO_TOOLS_ENABLED=false)." };

  const raw = Object.fromEntries(form);
  const parsed = schema.safeParse({ ...raw, questId: raw.questId ? raw.questId : undefined });
  if (!parsed.success) return { error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  const input = parsed.data;

  const db = await getDb();
  const quest = input.questId
    ? (await db.select().from(goals).where(and(eq(goals.id, input.questId), eq(goals.type, "quest"))))[0]
    : null;
  const [anyQuest] = await db.select().from(goals).where(eq(goals.type, "quest")).limit(1);

  const fake = buildSimulatedActivity({
    distanceKm: input.distanceKm,
    paceSecPerKm: input.paceMin * 60 + input.paceSec,
    sportType: input.sportType,
    quest,
    home: anyQuest?.lat != null && anyQuest.lng != null ? [anyQuest.lat, anyQuest.lng] : undefined,
  });

  await logEvent(db, { kind: "demo.simulate", message: `Simulated ${input.sportType} ${input.distanceKm} km${quest ? ` via ${quest.name}` : ""}` });
  const { activity } = await storeActivity(db, fake, "simulated");
  const outcome = await processActivity(db, activity, pipelineDeps());
  revalidatePath("/");
  return { outcome };
}
