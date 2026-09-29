import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { getRewardView } from "@/lib/reward-view";
import { advanceCheckout } from "@/lib/rewards";

/**
 * Polled by the live reward page. While a checkout is running it also nudges
 * the provider, so progress continues even if the background loop was cut off.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  const db = await getDb();
  const view = await getRewardView(db, id);
  if (!view) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (view.status === "checking_out") {
    await advanceCheckout(db, id);
    return NextResponse.json(await getRewardView(db, id));
  }
  return NextResponse.json(view);
}
