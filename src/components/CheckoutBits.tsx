"use client";

import { useEffect, useState } from "react";
import { formatCad } from "@/lib/format";
import type { CheckoutStatus } from "@/lib/providers/types";

/** Cart-link checkout: the store's checkout is open in your browser; you pay, then tell the app. */
export function CartReady({
  checkout,
  quotedTotalCents,
  pending,
  onConfirm,
}: {
  checkout: CheckoutStatus;
  quotedTotalCents: number | null;
  pending: boolean;
  onConfirm: (placed: boolean, total?: string, orderNumber?: string) => void;
}) {
  const [total, setTotal] = useState(quotedTotalCents ? (quotedTotalCents / 100).toFixed(2) : "");
  const [order, setOrder] = useState("");
  return (
    <div className="card border-volt/40">
      <p className="eyebrow text-volt">Your cart is ready</p>
      <p className="mt-2 text-2xl font-bold">Finish paying in your browser</p>
      <p className="mt-1 text-muted">{checkout.needsInput?.question}</p>
      {checkout.handoffUrl && (
        <a href={checkout.handoffUrl} target="_blank" rel="noreferrer" className="btn-primary mt-4 px-6 py-3 text-lg">
          Open checkout ↗
        </a>
      )}
      <div className="mt-6 grid gap-3 border-t border-line pt-5 sm:grid-cols-3">
        <label>
          <span className="label">Total paid (CAD)</span>
          <input value={total} onChange={(e) => setTotal(e.target.value)} inputMode="decimal" className="input mt-1 tabular-nums" />
        </label>
        <label className="sm:col-span-2">
          <span className="label">Order number (optional)</span>
          <input value={order} onChange={(e) => setOrder(e.target.value)} className="input mt-1" />
        </label>
      </div>
      <div className="mt-4 flex flex-wrap gap-3">
        <button disabled={pending} onClick={() => onConfirm(true, total, order)} className="btn-primary px-6 py-3">
          I placed the order
        </button>
        <button disabled={pending} onClick={() => onConfirm(false)} className="btn px-6 py-3">
          I didn&apos;t buy it
        </button>
      </div>
    </div>
  );
}

export function Countdown({
  at,
  onCancel,
  pending,
  label = "Buying it in a moment…",
}: {
  at: string;
  onCancel: () => void;
  pending: boolean;
  label?: string;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(t);
  }, []);
  const left = Math.max(0, Math.ceil((Date.parse(at) - now) / 1000));
  return (
    <div className="card flex flex-wrap items-center justify-between gap-4 border-volt/40">
      <div className="flex items-center gap-5">
        <span key={left} className="countdown-tick text-6xl font-black tabular-nums text-volt">
          {left}
        </span>
        <p className="text-xl">{left > 0 ? label : "Starting checkout…"}</p>
      </div>
      <button disabled={pending || left === 0} onClick={onCancel} className="btn px-6 py-3 text-lg">
        Cancel
      </button>
    </div>
  );
}

/** The provider's step-by-step progress (mock, browser agent, or cart link). */
export function CheckoutPanel({
  checkout,
  provider,
  live,
  pending,
  onResume,
}: {
  checkout: CheckoutStatus | null;
  provider: string | null;
  live: boolean;
  pending: boolean;
  onResume: () => void;
}) {
  return (
    <div className="card">
      <div className="flex items-center justify-between">
        <p className="eyebrow">
          Checkout · {provider === "browser" ? "Claude in Chrome on this PC" : provider === "cart" ? "store's own checkout, you pay" : provider}
        </p>
        {provider === "mock" && <span className="pill text-muted">simulated, no money</span>}
        {provider === "browser" && <span className="pill text-muted">watch the Chrome window</span>}
      </div>
      {checkout?.state === "awaiting_input" && !checkout.handoffUrl && (
        <div className="mt-4 rounded-xl border border-warn/50 bg-warn/10 p-4">
          <p className="font-semibold text-warn">The agent needs you in the browser window</p>
          <p className="mt-1">{checkout.needsInput?.question}</p>
          <button disabled={pending} onClick={onResume} className="btn-primary mt-3">
            Done, continue
          </button>
        </div>
      )}
      <ol className="mt-4 space-y-2">
        {(checkout?.steps ?? []).map((s, i, all) => {
          const current = i === all.length - 1 && live;
          return (
            <li key={`${s.label}-${i}`} className="flex items-center gap-3 text-lg">
              <span className={`size-2.5 rounded-full ${current ? "animate-pulse bg-volt" : "bg-good"}`} />
              <span className={current ? "text-fg" : "text-muted"}>{s.label}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export function Receipt({ receipt, totalChargedCents }: { receipt: unknown; totalChargedCents: number | null }) {
  const dry = !!(receipt && typeof receipt === "object" && (receipt as { dryRun?: boolean }).dryRun);
  if (dry) {
    return (
      <div className="card border-warn/40">
        <p className="eyebrow text-warn">Dry run: no order placed</p>
        <p className="mt-2 text-4xl font-black tabular-nums">{formatCad((receipt as { totalCents?: number }).totalCents)}</p>
        <p className="mt-1 text-muted">The agent reached the review page and stopped. Set PURCHASES_ENABLED=true to buy for real.</p>
      </div>
    );
  }
  return (
    <div className="card border-good/40">
      <p className="eyebrow text-good">Receipt</p>
      <p className="mt-2 text-4xl font-black tabular-nums">{formatCad(totalChargedCents)}</p>
      <pre className="mt-4 overflow-x-auto rounded-lg bg-surface-2 p-4 font-mono text-xs text-muted">{JSON.stringify(receipt, null, 2)}</pre>
    </div>
  );
}
