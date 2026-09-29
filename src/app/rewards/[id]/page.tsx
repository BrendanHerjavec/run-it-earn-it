import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { getDb } from "@/db";
import { goals } from "@/db/schema";
import { AppShell } from "@/components/AppShell";
import { getRewardView } from "@/lib/reward-view";
import { getUser } from "@/lib/settings";
import { RewardLive } from "./RewardLive";

export const dynamic = "force-dynamic";

export default async function RewardPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ unlocked?: string }>;
}) {
  const id = Number((await params).id);
  const unlocked = (await searchParams).unlocked === "1";
  if (!Number.isInteger(id)) notFound();
  const db = await getDb();
  const [view, user, questGoals] = await Promise.all([
    getRewardView(db, id),
    getUser(db),
    db.select().from(goals).where(eq(goals.type, "quest")),
  ]);
  if (!view) notFound();

  const quests = questGoals
    .filter((q) => q.lat != null && q.lng != null)
    .map((q) => ({ id: q.id, name: q.name, lat: q.lat!, lng: q.lng!, radiusM: q.radiusM ?? 75, active: q.active }));

  return (
    <AppShell wide>
      <RewardLive initial={view} quests={quests} timeZone={user.timezone} unlocked={unlocked} />
    </AppShell>
  );
}
