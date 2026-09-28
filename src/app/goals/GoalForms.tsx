"use client";

import dynamic from "next/dynamic";
import { useActionState, useState } from "react";
import { TIERS } from "@/lib/tiers";
import type { QuestPin } from "@/components/QuestMap";
import { createDistanceGoal, createQuest, type FormState } from "./actions";

const QuestMap = dynamic(() => import("@/components/QuestMap"), {
  ssr: false,
  loading: () => <div className="h-[420px] w-full animate-pulse rounded-xl bg-surface-2" />,
});

function TierSelect({ defaultValue = "small" }: { defaultValue?: string }) {
  return (
    <select name="rewardTier" defaultValue={defaultValue} className="input mt-1">
      {TIERS.map((t) => (
        <option key={t} value={t}>
          {t}
        </option>
      ))}
    </select>
  );
}

export function DistanceGoalForm() {
  const [state, action, pending] = useActionState<FormState, FormData>(createDistanceGoal, {});
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-12">
      <label className="sm:col-span-4">
        <span className="label">Name</span>
        <input name="name" required className="input mt-1" placeholder="Run 10 km" />
      </label>
      <label className="sm:col-span-3">
        <span className="label">Type</span>
        <select name="type" className="input mt-1">
          <option value="single_run_distance">Single run</option>
          <option value="weekly_distance">Weekly total</option>
        </select>
      </label>
      <label className="sm:col-span-2">
        <span className="label">Target km</span>
        <input name="targetKm" inputMode="decimal" required className="input mt-1 tabular-nums" placeholder="5" />
      </label>
      <label className="sm:col-span-2">
        <span className="label">Reward tier</span>
        <TierSelect defaultValue="medium" />
      </label>
      <div className="flex items-end sm:col-span-1">
        <button disabled={pending} className="btn-primary w-full">
          Add
        </button>
      </div>
      {state.error && <p className="text-sm text-bad sm:col-span-12">{state.error}</p>}
    </form>
  );
}

export function QuestForm({ quests }: { quests: QuestPin[] }) {
  const [state, action, pending] = useActionState<FormState, FormData>(createQuest, {});
  const [pin, setPin] = useState<{ lat: number; lng: number } | null>(null);
  const [radiusM, setRadiusM] = useState(75);

  return (
    <div className="space-y-4">
      <QuestMap quests={quests} draft={pin ? { ...pin, radiusM } : null} onPick={(lat, lng) => setPin({ lat, lng })} />
      <form
        action={async (fd) => {
          await action(fd);
          setPin(null);
        }}
        className="grid gap-3 sm:grid-cols-12"
      >
        <input type="hidden" name="lat" value={pin?.lat ?? ""} />
        <input type="hidden" name="lng" value={pin?.lng ?? ""} />
        <label className="sm:col-span-4">
          <span className="label">Quest name</span>
          <input name="name" required className="input mt-1" placeholder="The big oak in High Park" />
        </label>
        <label className="sm:col-span-4">
          <span className="label">Radius: {radiusM} m</span>
          <input
            name="radiusM"
            type="range"
            min={25}
            max={500}
            step={5}
            value={radiusM}
            onChange={(e) => setRadiusM(Number(e.target.value))}
            className="mt-3 w-full accent-[var(--volt)]"
          />
        </label>
        <label className="sm:col-span-2">
          <span className="label">Reward tier</span>
          <TierSelect />
        </label>
        <div className="flex items-end sm:col-span-2">
          <button disabled={pending || !pin} className="btn-primary w-full">
            {pin ? "Save quest" : "Click the map"}
          </button>
        </div>
        {pin && (
          <p className="font-mono text-xs text-muted sm:col-span-12">
            {pin.lat.toFixed(5)}, {pin.lng.toFixed(5)}
          </p>
        )}
        {state.error && <p className="text-sm text-bad sm:col-span-12">{state.error}</p>}
      </form>
    </div>
  );
}
