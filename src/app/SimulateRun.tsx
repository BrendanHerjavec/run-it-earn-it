"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { simulateRun, type SimulateState } from "./demo-actions";

const OUTCOME_STYLE: Record<string, string> = {
  reward_created: "border-volt/50 text-volt",
  skipped_budget: "border-warn/50 text-warn",
  flagged: "border-bad/50 text-bad",
  no_goal: "text-muted",
  ignored: "text-muted",
  duplicate: "text-muted",
};

export function SimulateRun({ quests }: { quests: { id: number; name: string }[] }) {
  const [state, action, pending] = useActionState<SimulateState, FormData>(simulateRun, {});
  const [km, setKm] = useState(5.2);

  return (
    <form action={action} className="card space-y-4 border-dashed">
      <div className="flex items-center justify-between">
        <p className="eyebrow">Demo · simulate a run</p>
        <span className="pill text-muted">no Strava needed</span>
      </div>

      <label className="block">
        <span className="label">Distance: <b className="text-fg tabular-nums">{km.toFixed(1)} km</b></span>
        <input
          name="distanceKm"
          type="range"
          min={0.5}
          max={25}
          step={0.1}
          value={km}
          onChange={(e) => setKm(Number(e.target.value))}
          className="mt-2 w-full accent-[var(--volt)]"
        />
      </label>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <label>
          <span className="label">Pace min</span>
          <input name="paceMin" type="number" min={1} max={20} defaultValue={5} className="input mt-1 tabular-nums" />
        </label>
        <label>
          <span className="label">sec /km</span>
          <input name="paceSec" type="number" min={0} max={59} defaultValue={30} className="input mt-1 tabular-nums" />
        </label>
        <label>
          <span className="label">Type</span>
          <select name="sportType" defaultValue="Run" className="input mt-1">
            <option>Run</option>
            <option>TrailRun</option>
            <option>Ride</option>
            <option>Walk</option>
          </select>
        </label>
        <label>
          <span className="label">Route</span>
          <select name="questId" defaultValue="" className="input mt-1">
            <option value="">Loop (no quest)</option>
            {quests.map((q) => (
              <option key={q.id} value={q.id}>
                via {q.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <button disabled={pending} className="btn-primary w-full">
        {pending ? "Running the pipeline…" : "Simulate run"}
      </button>

      {state.error && <p className="text-sm text-bad">{state.error}</p>}
      {state.outcome && (
        <div className="rounded-xl border border-line bg-surface-2 p-4 text-sm">
          <span className={`pill ${OUTCOME_STYLE[state.outcome.status] ?? ""}`}>{state.outcome.status.replace("_", " ")}</span>
          <p className="mt-2 text-muted">{state.outcome.reason}</p>
          {"rewardEventId" in state.outcome && state.outcome.rewardEventId && (
            <Link href={`/rewards/${state.outcome.rewardEventId}`} className="mt-2 inline-block font-semibold text-volt underline">
              Open reward #{state.outcome.rewardEventId} →
            </Link>
          )}
        </div>
      )}
    </form>
  );
}
