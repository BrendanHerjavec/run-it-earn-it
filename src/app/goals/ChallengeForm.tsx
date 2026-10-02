"use client";

import { useActionState, useState } from "react";
import { createChallenge, type FormState } from "./actions";

type Item = { id: number; title: string; priceCents: number };

// Fancier the further you get: each milestone must beat the last one's limit.
const DEFAULTS = [
  { km: "5", max: "30" },
  { km: "10", max: "40" },
  { km: "20", max: "55" },
];

export function ChallengeForm({ items, today }: { items: Item[]; today: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(createChallenge, {});
  const [rows, setRows] = useState(DEFAULTS.length);
  const [shop, setShop] = useState(true);

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
      <label className="flex items-start gap-3">
        <input type="checkbox" name="basket" defaultChecked className="mt-1 size-4 accent-[var(--volt)]" />
        <span>
          <span className="font-semibold">One order at the end of the week</span>
          <span className="block text-sm text-muted">
            Each milestone adds its reward to a basket; everything is bought together when the week ends.
          </span>
        </span>
      </label>
      <div className="space-y-3">
        <label className="flex items-start gap-3">
          <input type="checkbox" checked={shop} onChange={(e) => setShop(e.target.checked)} className="mt-1 size-4 accent-[var(--volt)]" />
          <span>
            <span className="font-semibold">Claude shops a store instead of the wishlist</span>
            <span className="block text-sm text-muted">
              Picks from the store&apos;s live, in-stock shelf, fancier at each milestone, and never the same thing twice.
            </span>
          </span>
        </label>
        {shop && (
          <div className="grid gap-3 sm:grid-cols-12">
            <label className="sm:col-span-6">
              <span className="label">Store collection</span>
              <input name="shopUrl" type="url" required defaultValue="https://eightouncecoffee.ca/collections/funky" className="input mt-1" />
            </label>
            <label className="sm:col-span-6">
              <span className="label">Only products tagged</span>
              <input name="shopTag" defaultValue="meth_Filter, whole bean" placeholder="e.g. meth_Filter" className="input mt-1" />
            </label>
          </div>
        )}
        <label className="flex flex-wrap items-center gap-3">
          <span className="text-sm">Free shipping over</span>
          <span className="relative w-28">
            <span className="pointer-events-none absolute left-3 top-2 text-muted">$</span>
            <input name="freeShipping" inputMode="decimal" defaultValue="75" placeholder="none" className="input pl-7 tabular-nums" />
          </span>
          <span className="text-sm text-muted">Under it, the basket waits and rolls into next week. Leave empty to always order.</span>
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
              <span className="sr-only">Max price</span>
              <div className="relative">
                <span className="pointer-events-none absolute left-3 top-2 text-muted">up to $</span>
                <input name={`max_${i}`} inputMode="decimal" defaultValue={DEFAULTS[i]?.max ?? ""} placeholder="40" className="input pl-20 tabular-nums" />
              </div>
            </label>
            <label className="sm:col-span-7">
              <span className="sr-only">Reward item</span>
              <select name={`item_${i}`} defaultValue="" className="input">
                <option value="">{shop ? "Claude picks from the store (within the price limit)" : "Claude picks (within the price limit)"}</option>
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
