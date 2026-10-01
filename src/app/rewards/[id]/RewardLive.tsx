"use client";

import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import type { RewardView } from "@/lib/reward-view";
import type { QuestPin } from "@/components/QuestMap";
import { formatCad, formatDuration, formatKm, formatPace } from "@/lib/format";
import { decodePolyline } from "@/lib/geo";
import { RouteMap } from "./RouteMap";
import { approveAction, cancelAction, resumeAction, retryAgentAction, skipAction } from "./actions";

const STAGES = [
  { key: "run", label: "Run", short: "Run" },
  { key: "agent", label: "Claude picks", short: "Pick" },
  { key: "approval", label: "Approval", short: "Go" },
  { key: "checkout", label: "Checkout", short: "Buy" },
  { key: "done", label: "Ordered", short: "Done" },
] as const;

function stageIndex(v: RewardView): number {
  switch (v.status) {
    case "pending_agent":
      return 1;
    case "awaiting_approval":
      return 2;
    case "approved":
    case "checking_out":
      return 3;
    case "completed":
      return 4;
    default:
      return v.item ? (v.provider ? 3 : 2) : 1;
  }
}

const TERMINAL = ["completed", "failed", "rejected", "skipped_budget"];

function Stepper({ view }: { view: RewardView }) {
  const at = stageIndex(view);
  const ended = TERMINAL.includes(view.status);
  const bad = ["failed", "rejected", "skipped_budget"].includes(view.status);
  return (
    <ol className="grid grid-cols-5 gap-2">
      {STAGES.map((s, i) => {
        const done = i < at || (i === at && view.status === "completed");
        const active = i === at && !ended;
        const failedHere = i === at && bad;
        return (
          <li key={s.key} className="flex flex-col gap-2">
            <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
              <div
                className={`h-full rounded-full transition-all duration-700 ${failedHere ? "bg-bad" : done ? "bg-volt" : active ? "animate-pulse bg-volt/60" : ""}`}
                style={{ width: done || active || failedHere ? "100%" : "0%" }}
              />
            </div>
            <span className={`min-w-0 text-xs font-semibold uppercase tracking-wider sm:text-sm ${done || active ? "text-fg" : "text-muted"} ${failedHere ? "text-bad" : ""}`}>
              <span className="sm:hidden">{s.short}</span>
              <span className="hidden sm:inline">{s.label}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function isDryRun(v: RewardView) {
  return !!(v.receipt && typeof v.receipt === "object" && (v.receipt as { dryRun?: boolean }).dryRun);
}

/** Full-screen "reward unlocked" moment after Sync, then it gets out of the way. */
function UnlockOverlay({ view, onDone }: { view: RewardView; onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 3400);
    return () => clearTimeout(t);
  }, [onDone]);
  return (
    <div className="unlock-overlay fixed inset-0 z-[2000] grid place-items-center bg-bg/95 backdrop-blur" onClick={onDone}>
      <div className="relative text-center">
        <div className="unlock-rays pointer-events-none absolute left-1/2 top-1/2 -z-10 size-[140vmin]" style={{ transform: "translate(-50%, -50%)" }} />
        <p className="unlock-pop eyebrow text-volt">{view.goal?.name ?? "Goal"} complete</p>
        <h2 className="unlock-pop mt-4 text-6xl font-black tracking-tight sm:text-8xl" style={{ animationDelay: "120ms" }}>
          REWARD
          <br />
          <span className="text-volt">UNLOCKED</span>
        </h2>
        <p className="unlock-pop mt-6 text-3xl font-bold tabular-nums text-muted" style={{ animationDelay: "320ms" }}>
          {formatKm(view.activity.distanceM, 2)} · {formatPace(view.activity.movingTimeS, view.activity.distanceM)}
        </p>
      </div>
    </div>
  );
}

function Countdown({ at, onCancel, pending }: { at: string; onCancel: () => void; pending: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(t);
  }, []);
  const left = Math.max(0, Math.ceil((Date.parse(at) - now) / 1000));
  return (
    <div className="card flex flex-wrap items-center justify-between gap-4 border-volt/40">
      <div className="flex items-center gap-5">
        <span key={left} className="countdown-tick text-6xl font-black tabular-nums text-volt">{left}</span>
        <p className="text-xl">{left > 0 ? "Buying it in a moment…" : "Starting checkout…"}</p>
      </div>
      <button disabled={pending || left === 0} onClick={onCancel} className="btn px-6 py-3 text-lg">
        Cancel
      </button>
    </div>
  );
}

function headline(v: RewardView): string {
  if (v.status === "completed" && isDryRun(v)) return `Dry run: ${v.item?.title ?? "reward"}`;
  if (v.status === "pending_agent") return "Claude is choosing your reward…";
  if (v.status === "skipped_budget") return "Budget's spent for now";
  if (v.status === "rejected") return `Skipped: ${v.item?.title ?? "reward"}`;
  if (v.status === "failed" && !v.item) return "Claude couldn't pick";
  return v.item?.title ?? "Reward";
}

export function RewardLive({
  initial,
  quests,
  timeZone,
  unlocked = false,
}: {
  initial: RewardView;
  quests: QuestPin[];
  timeZone: string;
  unlocked?: boolean;
}) {
  const [view, setView] = useState(initial);
  const [showUnlock, setShowUnlock] = useState(unlocked);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const live = !TERMINAL.includes(view.status);

  useEffect(() => {
    if (!live) return;
    let stop = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/rewards/${view.id}/state`, { cache: "no-store" });
        if (res.ok && !stop) setView(await res.json());
      } catch {}
    };
    const t = setInterval(tick, 1500);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [live, view.id]);

  const act = (fn: (id: number) => Promise<{ ok: boolean; error?: string }>) =>
    startTransition(async () => {
      setError(null);
      const r = await fn(view.id);
      if (!r.ok) setError(r.error ?? "Something went wrong");
      const res = await fetch(`/api/rewards/${view.id}/state`, { cache: "no-store" });
      if (res.ok) setView(await res.json());
    });

  const route = decodePolyline(view.activity.polyline);
  const a = view.activity;

  return (
    <div className="space-y-8">
      {showUnlock && <UnlockOverlay view={view} onDone={() => setShowUnlock(false)} />}
      <header className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="eyebrow">
            Reward #{view.id} · {a.source === "simulated" ? "demo run" : "Strava"} · {view.goal?.name}
          </p>
          <span className={`pill px-3 py-1 text-sm ${view.status === "completed" ? "border-good/50 text-good" : ["failed", "rejected"].includes(view.status) ? "border-bad/50 text-bad" : "border-volt/40 text-volt"}`}>
            {view.status.replaceAll("_", " ")}
          </span>
        </div>
        <h1 className="text-4xl font-black tracking-tight sm:text-6xl">{headline(view)}</h1>
        {view.siblings.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted">This run also unlocked:</span>
            {view.siblings.map((s) => (
              <Link key={s.id} href={`/rewards/${s.id}`} className="pill border-volt/40 px-3 py-1 text-volt">
                {s.goalName ?? `Reward #${s.id}`} · {s.itemTitle ?? s.status.replaceAll("_", " ")}
              </Link>
            ))}
          </div>
        )}
        <Stepper view={view} />
      </header>

      <section className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {[
          ["Distance", formatKm(a.distanceM, 2)],
          ["Pace", formatPace(a.movingTimeS, a.distanceM)],
          ["Time", formatDuration(a.movingTimeS)],
          ["Reward tier", view.goal?.rewardTier ?? "—"],
        ].map(([k, v]) => (
          <div key={k} className="card">
            <p className="eyebrow">{k}</p>
            <p className="mt-2 text-3xl font-bold tabular-nums sm:text-4xl">{v}</p>
          </div>
        ))}
      </section>

      <div className="grid gap-8 lg:grid-cols-5">
        <div className="space-y-6 lg:col-span-3">
          {view.status === "pending_agent" && (
            <div className="card flex items-center gap-4">
              <span className="size-3 animate-ping rounded-full bg-volt" />
              <p className="text-xl">Claude is looking at your run, your wishlist and your budget…</p>
            </div>
          )}

          {view.agentMessage && (
            <div className="card border-volt/30">
              <p className="eyebrow text-volt">Claude says</p>
              <p className="mt-3 text-2xl leading-snug sm:text-3xl">&ldquo;{view.agentMessage}&rdquo;</p>
              {view.item && (
                <div className="mt-6 flex flex-wrap items-end justify-between gap-4 border-t border-line pt-5">
                  <div>
                    <p className="text-xl font-bold">{view.item.title}</p>
                    <p className="text-sm text-muted">
                      {formatCad(view.item.priceCents)} · {view.quotedTotalCents ? `${formatCad(view.quotedTotalCents)} incl. tax` : ""} · {view.item.tier}
                    </p>
                  </div>
                  {view.maxSpendCents != null && <p className="text-sm text-muted">hard cap {formatCad(view.maxSpendCents)}</p>}
                </div>
              )}
            </div>
          )}

          {(view.status === "awaiting_approval" || view.status === "checking_out" || (view.status === "failed" && !view.item)) && (
            <div className="flex flex-wrap gap-3">
              {view.status === "awaiting_approval" && view.autoApproveAt && (
                <div className="w-full">
                  <Countdown at={view.autoApproveAt} pending={pending} onCancel={() => act(skipAction)} />
                </div>
              )}
              {view.status === "awaiting_approval" && !view.autoApproveAt && (
                <>
                  <button disabled={pending} onClick={() => act(approveAction)} className="btn-primary px-8 py-3 text-lg">
                    Approve
                  </button>
                  <button disabled={pending} onClick={() => act(skipAction)} className="btn px-6 py-3 text-lg">
                    Skip
                  </button>
                </>
              )}
              {view.status === "checking_out" && (
                <button disabled={pending} onClick={() => act(cancelAction)} className="btn-danger">
                  Cancel checkout
                </button>
              )}
              {view.status === "failed" && !view.item && (
                <button disabled={pending} onClick={() => act(retryAgentAction)} className="btn">
                  Retry Claude
                </button>
              )}
            </div>
          )}
          {error && <p className="text-bad">{error}</p>}
          {view.failureReason && view.status !== "pending_agent" && (
            <div className="card border-warn/40 text-warn">{view.failureReason}</div>
          )}

          {(view.checkout || view.status === "checking_out") && (
            <div className="card">
              <div className="flex items-center justify-between">
                <p className="eyebrow">Checkout · {view.provider === "browser" ? "Claude in Chrome on this PC" : view.provider}</p>
                {view.provider === "mock" && <span className="pill text-muted">simulated, no money</span>}
                {view.provider === "browser" && <span className="pill text-muted">watch the Chrome window</span>}
              </div>
              {view.checkout?.state === "awaiting_input" && (
                <div className="mt-4 rounded-xl border border-warn/50 bg-warn/10 p-4">
                  <p className="font-semibold text-warn">The agent needs you in the browser window</p>
                  <p className="mt-1">{view.checkout.needsInput?.question}</p>
                  <button disabled={pending} onClick={() => act(resumeAction)} className="btn-primary mt-3">
                    Done, continue
                  </button>
                </div>
              )}
              {view.liveViewUrl && (
                <iframe src={view.liveViewUrl} className="mt-4 aspect-video w-full rounded-xl border border-line bg-black" title="Live checkout" />
              )}
              <ol className="mt-4 space-y-2">
                {(view.checkout?.steps ?? []).map((s, i, all) => {
                  const current = i === all.length - 1 && view.status === "checking_out";
                  return (
                    <li key={s.label} className="flex items-center gap-3 text-lg">
                      <span className={`size-2.5 rounded-full ${current ? "animate-pulse bg-volt" : "bg-good"}`} />
                      <span className={current ? "text-fg" : "text-muted"}>{s.label}</span>
                    </li>
                  );
                })}
              </ol>
            </div>
          )}

          {view.status === "completed" && isDryRun(view) && (
            <div className="card border-warn/40">
              <p className="eyebrow text-warn">Dry run: no order placed</p>
              <p className="mt-2 text-4xl font-black tabular-nums">{formatCad((view.receipt as { totalCents?: number }).totalCents)}</p>
              <p className="mt-1 text-muted">The agent reached the review page and stopped. Set PURCHASES_ENABLED=true to buy for real.</p>
            </div>
          )}
          {view.status === "completed" && !isDryRun(view) && (
            <div className="card border-good/40">
              <p className="eyebrow text-good">Receipt</p>
              <p className="mt-2 text-4xl font-black tabular-nums">{formatCad(view.totalChargedCents)}</p>
              <pre className="mt-4 overflow-x-auto rounded-lg bg-surface-2 p-4 font-mono text-xs text-muted">
                {JSON.stringify(view.receipt, null, 2)}
              </pre>
            </div>
          )}

          {view.transcript && (
            <details className="card">
              <summary className="cursor-pointer font-semibold">
                Agent transcript <span className="text-sm font-normal text-muted">({view.transcript.model}, {view.transcript.steps.length} steps)</span>
              </summary>
              <ol className="mt-4 space-y-3">
                {view.transcript.steps.map((s, i) => (
                  <li key={i} className="rounded-lg bg-surface-2 p-3 text-sm">
                    {s.kind === "thinking" && <p className="italic text-muted">💭 {s.text}</p>}
                    {s.kind === "text" && <p>{s.text}</p>}
                    {s.kind === "tool_call" && (
                      <p className="font-mono text-volt">
                        → {s.name}({JSON.stringify(s.input)})
                      </p>
                    )}
                    {s.kind === "tool_result" && (
                      <pre className={`overflow-x-auto whitespace-pre-wrap font-mono text-xs ${s.isError ? "text-bad" : "text-muted"}`}>
                        ← {prettyJson(s.content)}
                      </pre>
                    )}
                  </li>
                ))}
              </ol>
            </details>
          )}
        </div>

        <aside className="space-y-6 lg:col-span-2">
          {route.length > 1 && <RouteMap route={route} quests={quests} />}
          <div>
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
          </div>
        </aside>
      </div>
    </div>
  );
}

function prettyJson(s: string) {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}
