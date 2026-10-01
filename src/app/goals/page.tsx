import { asc, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { challenges, goals, wishlistItems } from "@/db/schema";
import { ChallengeBar } from "@/components/ChallengeBar";
import { challengeProgress } from "@/lib/challenges";
import { getUser } from "@/lib/settings";
import { localDateKey } from "@/lib/time";
import { ChallengeForm } from "./ChallengeForm";
import { AppShell, PageTitle, TierPill } from "@/components/AppShell";
import { DistanceGoalForm, QuestForm } from "./GoalForms";
import { deleteChallenge, deleteGoal, toggleChallenge, toggleGoal } from "./actions";

export const dynamic = "force-dynamic";

const TYPE_LABEL = {
  single_run_distance: "Single run",
  weekly_distance: "Weekly total",
  quest: "Quest",
} as const;

export default async function GoalsPage() {
  const db = await getDb();
  const user = await getUser(db);
  const now = new Date();
  const [allGoals, items, allChallenges] = await Promise.all([
    db.select().from(goals).orderBy(desc(goals.active), desc(goals.createdAt)),
    db.select().from(wishlistItems).where(eq(wishlistItems.active, true)).orderBy(asc(wishlistItems.expectedPriceCents)),
    db.select().from(challenges).orderBy(desc(challenges.active), desc(challenges.createdAt)),
  ]);
  const progress = new Map(
    (await Promise.all(allChallenges.map((c) => challengeProgress(db, now, user.timezone, c.id)))).flat().map((p) => [p.challenge.id, p]),
  );
  const all = allGoals.filter((g) => g.challengeId == null);
  const quests = all
    .filter((g) => g.type === "quest" && g.lat != null && g.lng != null)
    .map((g) => ({ id: g.id, name: g.name, lat: g.lat!, lng: g.lng!, radiusM: g.radiusM ?? 75, active: g.active }));

  return (
    <AppShell>
      <PageTitle eyebrow="What earns a reward" title="Goals & quests" />

      <div className="grid gap-8">
        <section className="card">
          <h2 className="mb-1 text-lg font-semibold">New challenge</h2>
          <p className="mb-4 text-sm text-muted">
            Run a total distance inside a time window. Every milestone you pass unlocks its own reward: pick the item yourself, or let Claude choose within a tier.
          </p>
          <ChallengeForm items={items.map((i) => ({ id: i.id, title: i.title, priceCents: i.expectedPriceCents }))} today={localDateKey(now, user.timezone)} />
        </section>

        {allChallenges.length > 0 && (
          <section className="space-y-4">
            <h2 className="text-lg font-semibold">Challenges</h2>
            {allChallenges.map((c) => {
              const p = progress.get(c.id);
              return (
                <div key={c.id} className={c.active ? "" : "opacity-50"}>
                  {p && <ChallengeBar p={p} timeZone={user.timezone} />}
                  <div className="mt-2 flex flex-wrap items-center justify-between gap-2 px-1 text-sm text-muted">
                    <span>
                      From {c.startsOn}, {c.lengthDays} days{c.repeats ? ", repeats" : ""}
                    </span>
                    <div className="flex gap-2">
                      <form action={toggleChallenge}>
                        <input type="hidden" name="id" value={c.id} />
                        <input type="hidden" name="active" value={String(!c.active)} />
                        <button className="btn">{c.active ? "Pause" : "Activate"}</button>
                      </form>
                      <form action={deleteChallenge}>
                        <input type="hidden" name="id" value={c.id} />
                        <button className="btn-danger">Delete</button>
                      </form>
                    </div>
                  </div>
                </div>
              );
            })}
          </section>
        )}

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
