"use client";

import { useEffect, useState, useTransition } from "react";
import type { RewardView } from "@/lib/reward-view";
import type { QuestPin } from "@/components/QuestMap";
import { formatCad, formatDuration, formatKm, formatPace } from "@/lib/format";
import { decodePolyline } from "@/lib/geo";
import { RouteMap } from "./RouteMap";
import { approveAction, cancelAction, retryAgentAction, skipAction } from "./actions";

const STAGES = [
  { key: "run", label: "Run" },
  { key: "agent", label: "Claude picks" },
  { key: "approval", label: "Approval" },
  { key: "checkout", label: "Checkout" },
  { key: "done", label: "Ordered" },
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
            <span className={`text-xs font-semibold uppercase tracking-wider sm:text-sm ${done || active ? "text-fg" : "text-muted"} ${failedHere ? "text-bad" : ""}`}>
              {s.label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function headline(v: RewardView): string {
  if (v.status === "pending_agent") return "Claude is choosing your reward…";
  if (v.status === "skipped_budget") return "Budget's spent for now";
  if (v.status === "rejected") return `Skipped: ${v.item?.title ?? "reward"}`;
  if (v.status === "failed" && !v.item) return "Claude couldn't pick";
  return v.item?.title ?? "Reward";
}

export function RewardLive({ initial, quests, timeZone }: { initial: RewardView; quests: QuestPin[]; timeZone: string }) {
  const [view, setView] = useState(initial);
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
              {view.status === "awaiting_approval" && (
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
                <p className="eyebrow">Checkout · {view.provider}</p>
                {view.provider === "mock" && <span className="pill text-muted">simulated, no money</span>}
              </div>
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

          {view.status === "completed" && (
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
