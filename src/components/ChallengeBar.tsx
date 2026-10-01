import Link from "next/link";
import type { ChallengeProgress } from "@/lib/challenges";
import { formatKm } from "@/lib/format";

/** Running total with milestone markers that light up as they unlock. */
export function ChallengeBar({ p, timeZone }: { p: ChallengeProgress; timeZone: string }) {
  const ms = p.milestones.filter((m) => m.active);
  const maxKm = Math.max(1, ...ms.map((m) => m.km));
  const km = p.totalM / 1000;
  const pct = Math.min(100, (km / maxKm) * 100);
  const fmt = (d: Date) => d.toLocaleDateString("en-CA", { timeZone, month: "short", day: "numeric" });
  const next = ms.find((m) => !m.unlocked && km < m.km);

  return (
    <div className="card">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="eyebrow">Challenge</p>
          <p className="mt-1 text-xl font-bold">{p.challenge.name}</p>
        </div>
        <p className="text-sm text-muted">
          {p.window
            ? `${fmt(p.window.start)} → ${fmt(new Date(p.window.end.getTime() - 1))}`
            : "Not running right now"}
        </p>
      </div>

      <p className="mt-4 text-4xl font-black tabular-nums sm:text-5xl">
        {formatKm(p.totalM)} <span className="text-xl font-semibold text-muted">/ {maxKm} km</span>
      </p>

      <div className="relative mb-12 mt-5 h-3 rounded-full bg-surface-2">
        <div className="h-full rounded-full bg-volt transition-all duration-700" style={{ width: `${pct}%` }} />
        {ms.map((m) => {
          const left = (m.km / maxKm) * 100;
          const inner = (
            <>
              <span
                className={`block size-5 rounded-full border-2 ${m.unlocked ? "border-volt bg-volt" : "border-line bg-surface"}`}
                title={m.itemTitle ?? `${m.tier} reward`}
              />
              <span className={`mt-1 block whitespace-nowrap text-xs font-semibold ${m.unlocked ? "text-volt" : "text-muted"}`}>
                {m.km} km{m.unlocked ? " ✓" : ""}
              </span>
            </>
          );
          return (
            <div key={m.goalId} className="absolute top-1/2 flex -translate-y-[10px] flex-col items-center" style={{ left: `calc(${left}% - 10px)` }}>
              {m.rewardEventId ? <Link href={`/rewards/${m.rewardEventId}`}>{inner}</Link> : inner}
            </div>
          );
        })}
      </div>

      <p className="text-sm text-muted">
        {next
          ? `${(next.km - km).toFixed(1)} km to the ${next.km} km reward${next.itemTitle ? `: ${next.itemTitle}` : ""}`
          : ms.length
            ? "Every milestone unlocked. Nice work."
            : "No milestones."}
      </p>
    </div>
  );
}
