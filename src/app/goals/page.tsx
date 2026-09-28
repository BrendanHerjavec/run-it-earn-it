import { desc } from "drizzle-orm";
import { getDb } from "@/db";
import { goals } from "@/db/schema";
import { AppShell, PageTitle, TierPill } from "@/components/AppShell";
import { DistanceGoalForm, QuestForm } from "./GoalForms";
import { deleteGoal, toggleGoal } from "./actions";

export const dynamic = "force-dynamic";

const TYPE_LABEL = {
  single_run_distance: "Single run",
  weekly_distance: "Weekly total",
  quest: "Quest",
} as const;

export default async function GoalsPage() {
  const db = await getDb();
  const all = await db.select().from(goals).orderBy(desc(goals.active), desc(goals.createdAt));
  const quests = all
    .filter((g) => g.type === "quest" && g.lat != null && g.lng != null)
    .map((g) => ({ id: g.id, name: g.name, lat: g.lat!, lng: g.lng!, radiusM: g.radiusM ?? 75, active: g.active }));

  return (
    <AppShell>
      <PageTitle eyebrow="What earns a reward" title="Goals & quests" />

      <div className="grid gap-8">
        <section className="card">
          <h2 className="mb-4 text-lg font-semibold">New distance goal</h2>
          <DistanceGoalForm />
        </section>

        <section className="card">
          <h2 className="mb-1 text-lg font-semibold">New quest</h2>
          <p className="mb-4 text-sm text-muted">Click the map to drop a pin. Run through the circle to complete the quest.</p>
          <QuestForm quests={quests} />
        </section>

        <section>
          <h2 className="mb-4 text-lg font-semibold">All goals</h2>
          <div className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
            {all.map((g) => (
              <div key={g.id} className={`flex flex-wrap items-center justify-between gap-3 px-5 py-4 ${g.active ? "" : "opacity-50"}`}>
                <div className="flex flex-wrap items-center gap-3">
                  <span className="pill text-muted">{TYPE_LABEL[g.type]}</span>
                  <span className="font-semibold">{g.name}</span>
                  <span className="text-sm text-muted tabular-nums">
                    {g.type === "quest" ? `${g.radiusM} m radius` : `${g.targetKm} km`}
                  </span>
                  <TierPill tier={g.rewardTier} />
                </div>
                <div className="flex gap-2">
                  <form action={toggleGoal}>
                    <input type="hidden" name="id" value={g.id} />
                    <input type="hidden" name="active" value={String(!g.active)} />
                    <button className="btn">{g.active ? "Pause" : "Activate"}</button>
                  </form>
                  <form action={deleteGoal}>
                    <input type="hidden" name="id" value={g.id} />
                    <button className="btn-danger">Delete</button>
                  </form>
                </div>
              </div>
            ))}
            {all.length === 0 && <p className="px-5 py-4 text-muted">No goals yet.</p>}
          </div>
        </section>
      </div>
    </AppShell>
  );
}
