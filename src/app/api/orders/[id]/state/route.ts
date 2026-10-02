import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { advanceOrder, getOrderView } from "@/lib/basket";

/** Polled by the live order page; nudges the provider while the checkout runs. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  const db = await getDb();
  const view = await getOrderView(db, id);
  if (!view) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (view.status === "checking_out") {
    await advanceOrder(db, id);
    return NextResponse.json(await getOrderView(db, id));
  }
  return NextResponse.json(view);
}
