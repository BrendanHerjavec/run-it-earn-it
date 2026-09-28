import { asc, eq, or } from "drizzle-orm";
import { notFound } from "next/navigation";
import { getDb } from "@/db";
import { activities, eventLog, goals, rewardEvents, wishlistItems } from "@/db/schema";
import { AppShell, PageTitle, TierPill } from "@/components/AppShell";
import { formatCad, formatDuration, formatKm, formatPace } from "@/lib/format";
import { decodePolyline } from "@/lib/geo";
import { getUser } from "@/lib/settings";
import { RouteMap } from "./RouteMap";

export const dynamic = "force-dynamic";

export default async function RewardPage({ params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  if (!Number.isInteger(id)) notFound();
  const db = await getDb();
  const [row] = await db
    .select({ event: rewardEvents, activity: activities, goal: goals, item: wishlistItems })
    .from(rewardEvents)
    .innerJoin(activities, eq(rewardEvents.activityId, activities.id))
    .leftJoin(goals, eq(rewardEvents.goalId, goals.id))
    .leftJoin(wishlistItems, eq(rewardEvents.chosenItemId, wishlistItems.id))
    .where(eq(rewardEvents.id, id));
  if (!row) notFound();
  const { event, activity, goal, item } = row;

  const [user, log, questGoals] = await Promise.all([
    getUser(db),
    db
      .select()
      .from(eventLog)
      .where(or(eq(eventLog.rewardEventId, id), eq(eventLog.activityId, activity.id)))
      .orderBy(asc(eventLog.id)),
    db.select().from(goals).where(eq(goals.type, "quest")),
  ]);
  const route = decodePolyline(activity.polyline);

  return (
    <AppShell>
      <PageTitle eyebrow={`Reward #${event.id}`} title={item?.title ?? (event.status === "skipped_budget" ? "Budget used up" : "Claude is choosing…")}>
        <span className="pill border-volt/40 px-4 py-1.5 text-base text-volt">{event.status.replace("_", " ")}</span>
      </PageTitle>

      <section className="grid gap-4 sm:grid-cols-4">
        <div className="card">
          <p className="eyebrow">Distance</p>
          <p className="stat mt-2">{formatKm(activity.distanceM, 2)}</p>
        </div>
        <div className="card">
          <p className="eyebrow">Pace</p>
          <p className="stat mt-2">{formatPace(activity.movingTimeS, activity.distanceM)}</p>
        </div>
        <div className="card">
          <p className="eyebrow">Time</p>
          <p className="stat mt-2">{formatDuration(activity.movingTimeS)}</p>
        </div>
        <div className="card">
          <p className="eyebrow">Goal</p>
          <p className="mt-2 text-xl font-bold">{goal?.name ?? "—"}</p>
          {goal && <div className="mt-2"><TierPill tier={goal.rewardTier} /></div>}
        </div>
      </section>

      <div className="mt-8 grid gap-8 lg:grid-cols-5">
        <section className="space-y-4 lg:col-span-3">
          {event.agentMessage && (
            <div className="card">
              <p className="eyebrow">Claude says</p>
              <p className="mt-3 text-2xl leading-snug">{event.agentMessage}</p>
              {item && <p className="mt-4 text-lg font-semibold">{item.title} · {formatCad(item.expectedPriceCents)}</p>}
            </div>
          )}
          {event.failureReason && <div className="card border-warn/40 text-warn">{event.failureReason}</div>}
          {route.length > 1 && (
            <RouteMap
              route={route}
              quests={questGoals
                .filter((q) => q.lat != null && q.lng != null)
                .map((q) => ({ id: q.id, name: q.name, lat: q.lat!, lng: q.lng!, radiusM: q.radiusM ?? 75, active: q.active }))}
            />
          )}
        </section>

        <section className="lg:col-span-2">
          <h2 className="mb-4 text-lg font-semibold">Timeline</h2>
          <ol className="space-y-3 border-l border-line pl-5">
            {log.map((l) => (
              <li key={l.id}>
                <p className="font-mono text-xs text-muted">
                  {l.createdAt.toLocaleTimeString("en-CA", { timeZone: user.timezone })} · {l.kind}
                </p>
                <p className="text-sm">{l.message}</p>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </AppShell>
  );
}
