import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { activities, goals, rewardEvents, wishlistItems } from "@/db/schema";
import { AppShell, TierPill } from "@/components/AppShell";
import { getEffectiveSettings, getUser } from "@/lib/settings";
import { budgetStatus, runStreakDays, weeklyDistanceM } from "@/lib/stats";
import { formatCad, formatKm, formatPace } from "@/lib/format";
import { config } from "@/lib/config";
import { SimulateRun } from "./SimulateRun";

export const dynamic = "force-dynamic";

export default async function Home() {
  const db = await getDb();
  const [user, s] = await Promise.all([getUser(db), getEffectiveSettings(db)]);
  const now = new Date();
  const tz = user.timezone;

  const [weekM, streak, budget, activeGoals, latest, recent] = await Promise.all([
    weeklyDistanceM(db, now, tz),
    runStreakDays(db, now, tz),
    budgetStatus(db, s, now, tz),
    db.select().from(goals).where(eq(goals.active, true)).orderBy(goals.type, goals.targetKm),
    db
      .select({ event: rewardEvents, activity: activities, item: wishlistItems })
      .from(rewardEvents)
      .innerJoin(activities, eq(rewardEvents.activityId, activities.id))
      .leftJoin(wishlistItems, eq(rewardEvents.chosenItemId, wishlistItems.id))
      .orderBy(desc(rewardEvents.createdAt))
      .limit(1),
    db
      .select({ activity: activities, rewardId: rewardEvents.id, rewardStatus: rewardEvents.status })
      .from(activities)
      .leftJoin(rewardEvents, eq(rewardEvents.activityId, activities.id))
      .orderBy(desc(activities.startTime))
      .limit(8),
  ]);
  const demo = config().DEMO_TOOLS_ENABLED;

  const weeklyGoal = activeGoals.find((g) => g.type === "weekly_distance");
  const last = latest[0];

  return (
    <AppShell>
      <div className="mb-8 flex flex-wrap items-center gap-3">
        <span className={`pill ${s.purchasesEnabled ? "border-bad/50 text-bad" : "text-muted"}`}>
          purchases {s.purchasesEnabled ? "LIVE" : "off"}
        </span>
        <span className="pill text-muted">provider: {s.purchasesEnabled ? s.provider : "mock"}</span>
        <span className="pill text-muted">{s.autoBuy ? "auto-buy" : "approval mode"}</span>
      </div>

      <section className="grid gap-4 sm:grid-cols-3">
        <div className="card">
          <p className="eyebrow">This week</p>
          <p className="stat mt-2">{formatKm(weekM)}</p>
          {weeklyGoal?.targetKm && (
            <div className="mt-4">
              <div className="h-2 overflow-hidden rounded-full bg-surface-2">
                <div
                  className="h-full rounded-full bg-volt"
                  style={{ width: `${Math.min(100, (weekM / 1000 / weeklyGoal.targetKm) * 100)}%` }}
                />
              </div>
              <p className="mt-2 text-sm text-muted">of {weeklyGoal.targetKm} km weekly goal</p>
            </div>
          )}
        </div>
        <div className="card">
          <p className="eyebrow">Streak</p>
          <p className="stat mt-2">
            {streak} <span className="text-2xl text-muted">{streak === 1 ? "day" : "days"}</span>
          </p>
        </div>
        <div className="card">
          <p className="eyebrow">Reward budget left</p>
          <p className="stat mt-2">{formatCad(budget.availableForNextOrderCents)}</p>
          <p className="mt-2 text-sm text-muted">
            {formatCad(budget.remainingDailyCents)} today · {formatCad(budget.remainingWeeklyCents)} this week
          </p>
        </div>
      </section>

      <div className="mt-8 grid gap-8 lg:grid-cols-5">
        <section className="lg:col-span-3">
          <h2 className="mb-4 text-lg font-semibold">Latest reward</h2>
          {last ? (
            <Link href={`/rewards/${last.event.id}`} className="card block transition hover:border-muted">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className="pill text-volt border-volt/40">{last.event.status.replace("_", " ")}</span>
                <span className="text-sm text-muted">{last.activity.startTime.toLocaleString("en-CA", { timeZone: tz })}</span>
              </div>
              <p className="mt-4 text-2xl font-bold">{last.item?.title ?? "Choosing…"}</p>
              {last.event.agentMessage && <p className="mt-2 text-muted">{last.event.agentMessage}</p>}
              <p className="mt-4 text-sm text-muted">{formatKm(last.activity.distanceM, 2)} run</p>
            </Link>
          ) : (
            <div className="card text-muted">No rewards yet. Go for a run!</div>
          )}

          <h2 className="mb-4 mt-8 text-lg font-semibold">Recent activities</h2>
          <div className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
            {recent.map(({ activity: a, rewardId, rewardStatus }) => (
              <div key={a.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                <div className="min-w-0">
                  <p className="truncate font-semibold">
                    {a.name || a.sportType}
                    {a.source === "simulated" && <span className="pill ml-2 text-muted">demo</span>}
                  </p>
                  <p className="text-sm text-muted tabular-nums">
                    {a.sportType} · {formatKm(a.distanceM, 2)} · {formatPace(a.movingTimeS, a.distanceM)} ·{" "}
                    {a.startTime.toLocaleDateString("en-CA", { timeZone: tz, month: "short", day: "numeric" })}
                  </p>
                </div>
                {a.flagged ? (
                  <span className="pill border-bad/50 text-bad" title={a.flagReason ?? ""}>flagged</span>
                ) : rewardId ? (
                  <Link href={`/rewards/${rewardId}`} className="pill border-volt/40 text-volt">
                    {rewardStatus?.replace("_", " ")}
                  </Link>
                ) : (
                  <span className="pill text-muted">no reward</span>
                )}
              </div>
            ))}
            {recent.length === 0 && <p className="px-5 py-4 text-muted">No activities yet.</p>}
          </div>
        </section>

        <section className="space-y-8 lg:col-span-2">
          {demo && <SimulateRun quests={activeGoals.filter((g) => g.type === "quest").map((g) => ({ id: g.id, name: g.name }))} />}
          <div>
          <h2 className="mb-4 text-lg font-semibold">Active goals</h2>
          <div className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
            {activeGoals.map((g) => (
              <div key={g.id} className="flex items-center justify-between gap-3 px-5 py-3">
                <div>
                  <p className="font-semibold">{g.name}</p>
                  <p className="text-sm text-muted">
                    {g.type === "quest" ? `Quest · ${g.radiusM} m` : g.type === "weekly_distance" ? `${g.targetKm} km / week` : `${g.targetKm} km in one run`}
                  </p>
                </div>
                <TierPill tier={g.rewardTier} />
              </div>
            ))}
            {activeGoals.length === 0 && (
              <p className="px-5 py-4 text-muted">
                No active goals. <Link href="/goals" className="text-volt underline">Add one</Link>.
              </p>
            )}
          </div>
          </div>
        </section>
      </div>
    </AppShell>
  );
}
