"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

type Outcome = { status: string; reason: string; rewardEventId?: number };
type Result = { checked: number; newRuns: number; outcomes: Outcome[]; error?: string };

/**
 * The one button: pull new runs from COROS. If a run unlocks a reward, jump
 * straight to the reward page, where Claude picks and the purchase follows.
 */
export function SyncRuns({ connected }: { connected: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function sync() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/coros/poll?autobuy=1", { method: "POST" });
      const r = (await res.json()) as Result;
      if (r.error) return setMsg(r.error);
      const won = r.outcomes.find((o) => o.status === "reward_created" && o.rewardEventId);
      if (won) return router.push(`/rewards/${won.rewardEventId}?unlocked=1`);
      if (r.newRuns === 0) setMsg("No new runs since your last sync.");
      else setMsg(`${r.newRuns} new run(s) synced. ${r.outcomes.map((o) => o.reason).join(" · ")}`);
      router.refresh();
    } catch (err) {
      setMsg(String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!connected) {
    return (
      <div className="card flex flex-wrap items-center justify-between gap-4">
        <p className="text-muted">Connect COROS to sync your runs.</p>
        <Link href="/settings" className="btn-primary">Connect COROS</Link>
      </div>
    );
  }

  return (
    <div className="card border-volt/30 space-y-3 text-center">
      <button onClick={sync} disabled={busy} className="btn-primary w-full py-5 text-2xl font-black tracking-tight">
        {busy ? "Syncing…" : "Sync runs"}
      </button>
      <p className="text-sm text-muted">
        {msg ?? "Pulls new runs from COROS. If one hits a goal, Claude picks your reward and buys it."}
      </p>
    </div>
  );
}
