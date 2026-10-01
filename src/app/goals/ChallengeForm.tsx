"use client";

import { useActionState, useState } from "react";
import { TIERS } from "@/lib/tiers";
import { createChallenge, type FormState } from "./actions";

type Item = { id: number; title: string; priceCents: number };

const DEFAULTS = [
  { km: "5", tier: "small" },
  { km: "10", tier: "medium" },
  { km: "20", tier: "large" },
];

export function ChallengeForm({ items, today }: { items: Item[]; today: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(createChallenge, {});
  const [rows, setRows] = useState(DEFAULTS.length);

  return (
    <form action={action} className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-12">
        <label className="sm:col-span-5">
          <span className="label">Name</span>
          <input name="name" required defaultValue="Weekly 20K" className="input mt-1" />
        </label>
        <label className="sm:col-span-3">
          <span className="label">Starts</span>
          <input name="startsOn" type="date" required defaultValue={today} className="input mt-1" />
        </label>
        <label className="sm:col-span-2">
          <span className="label">Days</span>
          <input name="lengthDays" type="number" min={1} max={60} defaultValue={7} className="input mt-1 tabular-nums" />
        </label>
        <label className="flex items-end gap-2 pb-2 sm:col-span-2">
          <input type="checkbox" name="repeats" defaultChecked className="size-4 accent-[var(--volt)]" />
          <span className="text-sm">Repeat</span>
        </label>
      </div>

      <div className="space-y-2">
        <p className="label">Milestones: each one unlocks its own reward</p>
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="grid gap-3 sm:grid-cols-12">
            <label className="sm:col-span-2">
              <span className="sr-only">Distance km</span>
              <div className="relative">
                <input name={`km_${i}`} inputMode="decimal" defaultValue={DEFAULTS[i]?.km ?? ""} placeholder="km" className="input pr-10 tabular-nums" />
                <span className="pointer-events-none absolute right-3 top-2 text-muted">km</span>
              </div>
            </label>
            <label className="sm:col-span-3">
              <span className="sr-only">Reward tier</span>
              <select name={`tier_${i}`} defaultValue={DEFAULTS[i]?.tier ?? "small"} className="input">
                {TIERS.map((t) => (
                  <option key={t} value={t}>
                    {t} reward
                  </option>
                ))}
              </select>
            </label>
            <label className="sm:col-span-7">
              <span className="sr-only">Reward item</span>
              <select name={`item_${i}`} defaultValue="" className="input">
                <option value="">Claude picks within the tier</option>
                {items.map((it) => (
                  <option key={it.id} value={it.id}>
                    Always: {it.title} (${(it.priceCents / 100).toFixed(2)})
                  </option>
                ))}
              </select>
            </label>
          </div>
        ))}
        {rows < 6 && (
          <button type="button" onClick={() => setRows(rows + 1)} className="btn">
            + Milestone
          </button>
        )}
      </div>

      <div className="flex items-center gap-4">
        <button disabled={pending} className="btn-primary">
          Create challenge
        </button>
        {state.error && <p className="text-sm text-bad">{state.error}</p>}
        {state.ok && <p className="text-sm text-good">Challenge created.</p>}
      </div>
    </form>
  );
}
