"use client";

import { useActionState, useEffect, useRef } from "react";
import type { WishlistItem } from "@/db/schema";
import { TIERS, TIER_MAX_CENTS } from "@/lib/tiers";
import { saveItem, type FormState } from "./actions";

export function ItemForm({ item }: { item?: WishlistItem }) {
  const [state, action, pending] = useActionState<FormState, FormData>(saveItem, {});
  const ref = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.ok && !item) ref.current?.reset();
  }, [state, item]);

  return (
    <form ref={ref} action={action} className="grid gap-3 sm:grid-cols-12">
      {item && <input type="hidden" name="id" value={item.id} />}
      <label className="sm:col-span-5">
        <span className="label">Title</span>
        <input name="title" defaultValue={item?.title} required className="input mt-1" placeholder="Chocolate protein bars" />
      </label>
      <label className="sm:col-span-7">
        <span className="label">Product URL</span>
        <input
          name="productUrl"
          type="url"
          defaultValue={item?.productUrl}
          required
          className="input mt-1 font-mono text-sm"
          placeholder="https://..."
        />
      </label>
      <label className="sm:col-span-2">
        <span className="label">Expected price (CAD)</span>
        <input
          name="expectedPrice"
          inputMode="decimal"
          defaultValue={item ? (item.expectedPriceCents / 100).toFixed(2) : ""}
          required
          className="input mt-1 tabular-nums"
          placeholder="24.99"
        />
      </label>
      <label className="sm:col-span-2">
        <span className="label">Tier</span>
        <select name="tier" defaultValue={item?.tier ?? "small"} className="input mt-1">
          {TIERS.map((t) => (
            <option key={t} value={t}>
              {t} (≤ ${TIER_MAX_CENTS[t] / 100})
            </option>
          ))}
        </select>
      </label>
      <label className="sm:col-span-6">
        <span className="label">Notes for the checkout agent</span>
        <input name="notes" defaultValue={item?.notes} className="input mt-1" placeholder="Flavour: chocolate. Size: M." />
      </label>
      <label className="flex items-end gap-2 pb-2 sm:col-span-1">
        <input type="checkbox" name="active" defaultChecked={item?.active ?? true} className="size-4 accent-[var(--volt)]" />
        <span className="text-sm">Active</span>
      </label>
      <div className="flex items-end sm:col-span-1">
        <button disabled={pending} className={item ? "btn w-full" : "btn-primary w-full"}>
          {pending ? "…" : item ? "Save" : "Add"}
        </button>
      </div>
      {state.error && <p className="text-sm text-bad sm:col-span-12">{state.error}</p>}
    </form>
  );
}
