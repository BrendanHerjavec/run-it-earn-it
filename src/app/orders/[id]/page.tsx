import { notFound } from "next/navigation";
import { getDb } from "@/db";
import { AppShell } from "@/components/AppShell";
import { getOrderView } from "@/lib/basket";
import { getUser } from "@/lib/settings";
import { OrderLive } from "./OrderLive";

export const dynamic = "force-dynamic";

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  if (!Number.isInteger(id)) notFound();
  const db = await getDb();
  const [view, user] = await Promise.all([getOrderView(db, id), getUser(db)]);
  if (!view) notFound();
  return (
    <AppShell wide>
      <OrderLive initial={view} timeZone={user.timezone} />
    </AppShell>
  );
}
