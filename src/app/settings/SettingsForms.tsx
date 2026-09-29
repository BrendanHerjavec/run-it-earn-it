"use client";

import { useActionState } from "react";
import type { User } from "@/db/schema";
import { closeShoppingBrowser, openShoppingBrowser, saveLimits, saveProfile, type FormState } from "./actions";

type LimitsProps = {
  env: { maxOrderCents: number; maxDailyCents: number; maxWeeklyCents: number; autoBuyMaxCents: number; autoBuy: boolean; provider: string };
  row: {
    maxOrderCents: number | null;
    maxDailyCents: number | null;
    maxWeeklyCents: number | null;
    autoBuyMaxCents: number | null;
    autoBuy: boolean;
    provider: string | null;
    crossmintBuyerProfileId: string | null;
  };
};

const d = (c: number | null) => (c == null ? "" : (c / 100).toFixed(2));

function Saved({ state }: { state: FormState }) {
  if (state.error) return <p className="text-sm text-bad">{state.error}</p>;
  if (state.ok) return <p className="text-sm text-good">Saved.</p>;
  return null;
}

function CapField({ name, label, envCents, value }: { name: string; label: string; envCents: number; value: number | null }) {
  return (
    <label>
      <span className="label">{label}</span>
      <input name={name} inputMode="decimal" defaultValue={d(value)} placeholder={d(envCents)} className="input mt-1 tabular-nums" />
      <span className="mt-1 block text-xs text-muted">env ceiling: ${d(envCents)}</span>
    </label>
  );
}

export function LimitsForm({ env, row }: LimitsProps) {
  const [state, action, pending] = useActionState<FormState, FormData>(saveLimits, {});
  return (
    <form action={action} className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-4">
        <CapField name="maxOrder" label="Per order (CAD)" envCents={env.maxOrderCents} value={row.maxOrderCents} />
        <CapField name="maxDaily" label="Per day (CAD)" envCents={env.maxDailyCents} value={row.maxDailyCents} />
        <CapField name="maxWeekly" label="Per week (CAD)" envCents={env.maxWeeklyCents} value={row.maxWeeklyCents} />
        <CapField name="autoBuyMax" label="Auto-buy max (CAD)" envCents={env.autoBuyMaxCents} value={row.autoBuyMaxCents} />
      </div>
      <p className="text-xs text-muted">Leave blank to use the env value. Values above the env ceiling are ignored: the UI can tighten caps but never loosen them.</p>

      <div className="grid gap-4 sm:grid-cols-2">
        <label>
          <span className="label">Checkout provider</span>
          <select name="provider" defaultValue={row.provider ?? ""} className="input mt-1">
            <option value="">Use env ({env.provider})</option>
            <option value="mock">Mock (simulated, no money)</option>
            <option value="browser">Browser agent (Claude drives Chrome on this PC)</option>
            <option value="crossmint">Crossmint (real purchases)</option>
            <option value="rye">Rye (US addresses only)</option>
          </select>
        </label>
        <label>
          <span className="label">Crossmint buyer profile ID</span>
          <input name="crossmintBuyerProfileId" defaultValue={row.crossmintBuyerProfileId ?? ""} className="input mt-1 font-mono text-sm" placeholder="set up in Phase 4" />
        </label>
      </div>

      <label className="flex items-start gap-3">
        <input type="checkbox" name="autoBuy" defaultChecked={row.autoBuy} className="mt-1 size-4 accent-[var(--volt)]" />
        <span>
          <span className="font-semibold">Auto-buy small rewards</span>
          <span className="block text-sm text-muted">
            Skip the Approve tap for rewards under the auto-buy max. Only takes effect when AUTO_BUY=true in env (currently{" "}
            <b className={env.autoBuy ? "text-warn" : ""}>{String(env.autoBuy)}</b>).
          </span>
        </span>
      </label>

      <div className="flex items-center gap-4">
        <button disabled={pending} className="btn-primary">Save limits</button>
        <Saved state={state} />
      </div>
    </form>
  );
}

export function ProfileForm({ user }: { user: User }) {
  const [state, action, pending] = useActionState<FormState, FormData>(saveProfile, {});
  const field = (name: keyof User, label: string, span = "sm:col-span-3", props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <label className={span}>
      <span className="label">{label}</span>
      <input name={name} defaultValue={String(user[name] ?? "")} className="input mt-1" {...props} />
    </label>
  );
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-6">
      {field("name", "Name")}
      {field("email", "Email", "sm:col-span-3", { type: "email" })}
      {field("phone", "Phone", "sm:col-span-2", { type: "tel" })}
      {field("addressLine1", "Address", "sm:col-span-4")}
      {field("addressLine2", "Address line 2", "sm:col-span-2")}
      {field("city", "City", "sm:col-span-2")}
      {field("province", "Province", "sm:col-span-1")}
      {field("postalCode", "Postal code", "sm:col-span-1")}
      {field("country", "Country", "sm:col-span-1")}
      {field("timezone", "Timezone", "sm:col-span-1")}
      <div className="flex items-center gap-4 sm:col-span-6">
        <button disabled={pending} className="btn-primary">Save profile</button>
        <Saved state={state} />
      </div>
    </form>
  );
}

export function ShoppingBrowser({ open }: { open: boolean }) {
  const [state, action, pending] = useActionState<FormState, FormData>(openShoppingBrowser, {});
  return (
    <div className="space-y-3">
      <form action={action} className="flex flex-wrap items-end gap-3">
        <label className="min-w-64 flex-1">
          <span className="label">Store URL</span>
          <input name="url" type="url" required placeholder="https://www.your-store.ca/account/login" className="input mt-1 font-mono text-sm" />
        </label>
        <button disabled={pending} className="btn-primary">{pending ? "Opening…" : "Open shopping browser"}</button>
      </form>
      {open && (
        <form action={closeShoppingBrowser}>
          <button className="btn">Close shopping browser</button>
        </form>
      )}
      <Saved state={state} />
    </div>
  );
}
