"use server";

import { after } from "next/server";
import { getDb } from "@/db";
import { requireAuth } from "@/lib/auth";
import { logEvent } from "@/lib/events";
import { approveReward, cancelCheckout, resumeCheckout, retryAgent, runCheckoutLoop, runRewardAgent, skipReward } from "@/lib/rewards";

export type ActionResult = { ok: boolean; error?: string };

export async function approveAction(id: number): Promise<ActionResult> {
  await requireAuth();
  const db = await getDb();
  const r = await approveReward(db, id, "dashboard");
  if (!r.ok) return { ok: false, error: r.reason };
  after(() => runCheckoutLoop(db, id));
  return { ok: true };
}

export async function skipAction(id: number): Promise<ActionResult> {
  await requireAuth();
  const ok = await skipReward(await getDb(), id, "dashboard");
  return ok ? { ok } : { ok, error: "Not waiting for approval" };
}

export async function cancelAction(id: number): Promise<ActionResult> {
  await requireAuth();
  const ok = await cancelCheckout(await getDb(), id);
  return ok ? { ok } : { ok, error: "No checkout in progress" };
}

export async function retryAgentAction(id: number): Promise<ActionResult> {
  await requireAuth();
  const db = await getDb();
  if (!(await retryAgent(db, id))) return { ok: false, error: "Can only retry a failed reward that never reserved money" };
  after(async () => {
    try {
      await runRewardAgent(db, id);
      await runCheckoutLoop(db, id);
    } catch (err) {
      await logEvent(db, { kind: "pipeline.error", rewardEventId: id, message: String(err) });
    }
  });
  return { ok: true };
}

export async function resumeAction(id: number): Promise<ActionResult> {
  await requireAuth();
  const ok = await resumeCheckout(await getDb(), id, "I've handled it in the browser");
  return ok ? { ok } : { ok, error: "This checkout isn't waiting for you" };
}
