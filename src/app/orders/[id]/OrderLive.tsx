"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { CartReady, CheckoutPanel, Countdown, Receipt } from "@/components/CheckoutBits";
import type { OrderView } from "@/lib/basket";
import { formatCad } from "@/lib/format";
import { cancelOrderAction, confirmOrderAction, reopenOrderAction, resumeOrderAction } from "./actions";

const TERMINAL = ["completed", "failed", "rejected"];

export function OrderLive({ initial, timeZone }: { initial: OrderView; timeZone: string }) {
  const router = useRouter();
  const [view, setView] = useState(initial);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const live = !TERMINAL.includes(view.status);

  useEffect(() => {
    if (!live) return;
    const t = setInterval(async () => {
      try {
        const res = await fetch(`/api/orders/${view.id}/state`, { cache: "no-store" });
        // A cancelled order is deleted: back to the dashboard.
        if (res.status === 404) return router.push("/");
        if (res.ok) setView(await res.json());
      } catch {}
    }, 1500);
    return () => clearInterval(t);
  }, [live, view.id, router]);

  const act = (fn: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) =>
    startTransition(async () => {
      setError(null);
      const r = await fn();
      if (!r.ok) return setError(r.error ?? "Something went wrong");
      if (after) return after();
      const res = await fetch(`/api/orders/${view.id}/state`, { cache: "no-store" });
      if (res.ok) setView(await res.json());
    });

  const subtotal = view.lines.reduce((s, l) => s + l.priceCents, 0);
  const statusClass =
    view.status === "completed" ? "border-good/50 text-good" : ["failed", "rejected"].includes(view.status) ? "border-bad/50 text-bad" : "border-volt/40 text-volt";

  return (
    <div className="space-y-8">
      <header className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="eyebrow">
            Order #{view.id} · {view.challengeName} · week of {view.windowStartKey}
          </p>
          <span className={`pill px-3 py-1 text-sm ${statusClass}`}>{view.status.replaceAll("_", " ")}</span>
        </div>
        <h1 className="text-4xl font-black tracking-tight sm:text-6xl">
          {view.lines.length} reward{view.lines.length === 1 ? "" : "s"}, one order
        </h1>
        <p className="text-xl text-muted">
          {formatCad(subtotal)}
          {view.maxSpendCents ? ` · hard cap ${formatCad(view.maxSpendCents)}` : ""}
        </p>
      </header>

      <section className="grid gap-4 sm:grid-cols-3">
        {view.lines.map((l) => (
          <Link key={l.rewardId} href={`/rewards/${l.rewardId}`} className="card block transition hover:border-muted">
            <p className="eyebrow text-volt">{l.milestoneKm} km milestone</p>
            <p className="mt-2 text-xl font-bold">{l.title}</p>
            <p className="text-muted tabular-nums">{formatCad(l.priceCents)}</p>
            {l.message && <p className="mt-3 text-sm italic text-muted">&ldquo;{l.message}&rdquo;</p>}
          </Link>
        ))}
      </section>

      <div className="grid gap-8 lg:grid-cols-5">
        <div className="space-y-6 lg:col-span-3">
          {view.status === "awaiting_approval" && view.autoApproveAt && (
            <Countdown
              at={view.autoApproveAt}
              pending={pending}
              label="Checking out the basket in a moment…"
              onCancel={() => act(() => cancelOrderAction(view.id), () => router.push("/"))}
            />
          )}
          {view.status === "checking_out" && view.checkout?.state === "awaiting_input" && view.checkout.handoffUrl && (
            <CartReady
              checkout={view.checkout}
              quotedTotalCents={view.quotedTotalCents}
              pending={pending}
              onConfirm={(placed, total, order) => act(() => confirmOrderAction(view.id, placed, total, order))}
            />
          )}
          {(view.checkout || view.status === "checking_out") && (
            <CheckoutPanel
              checkout={view.checkout}
              provider={view.provider}
              live={view.status === "checking_out"}
              pending={pending}
              onResume={() => act(() => resumeOrderAction(view.id))}
            />
          )}
          {view.status === "completed" && <Receipt receipt={view.receipt} totalChargedCents={view.totalChargedCents} />}
          {["failed", "rejected"].includes(view.status) && (
            <div className="card border-warn/40">
              <p className="text-warn">{view.failureReason ?? "Not purchased."}</p>
              <button disabled={pending} onClick={() => act(() => reopenOrderAction(view.id), () => router.push("/"))} className="btn mt-4">
                Put the bags back in the basket
              </button>
            </div>
          )}
          {error && <p className="text-bad">{error}</p>}
        </div>

        <aside className="lg:col-span-2">
          <h2 className="mb-3 text-lg font-semibold">Timeline</h2>
          <ol className="space-y-3 border-l border-line pl-5">
            {view.log.map((l) => (
              <li key={l.id}>
                <p className="font-mono text-xs text-muted">
                  {new Date(l.at).toLocaleTimeString("en-CA", { timeZone })} · {l.kind}
                </p>
                <p className="break-words text-sm">{l.message}</p>
              </li>
            ))}
          </ol>
        </aside>
      </div>
    </div>
  );
}
