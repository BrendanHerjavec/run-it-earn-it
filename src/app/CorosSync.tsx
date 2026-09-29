"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

type Outcome = { status: string; reason: string; rewardEventId?: number };
type Result = { checked: number; newRuns: number; outcomes: Outcome[]; error?: string };

const AUTO_MS = 60_000;

/** Polls COROS while the dashboard is open, plus a manual "check now". */
export function CorosSync() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<{ at: Date; result: Result } | null>(null);
  const inFlight = useRef(false);

  const check = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const res = await fetch("/api/coros/poll", { method: "POST" });
      const result = (await res.json()) as Result;
      setLast({ at: new Date(), result });
      if (result.newRuns > 0) router.refresh();
    } catch (err) {
      setLast({ at: new Date(), result: { checked: 0, newRuns: 0, outcomes: [], error: String(err) } });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, [router]);

  useEffect(() => {
    const first = setTimeout(check, 0);
    const t = setInterval(check, AUTO_MS);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [check]);

  const reward = last?.result.outcomes.find((o) => o.rewardEventId);

  return (
    <div className="card flex flex-wrap items-center justify-between gap-3">
      <div>
        <p className="eyebrow">COROS</p>
        <p className="mt-1 text-sm text-muted">
          {busy
            ? "Checking for new runs…"
            : last?.result.error
              ? <span className="text-bad">{last.result.error}</span>
              : last
                ? `${last.result.newRuns ? `${last.result.newRuns} new run(s)` : "No new runs"} · checked ${last.at.toLocaleTimeString("en-CA")}`
                : "Auto-checks every minute while this page is open"}
        </p>
        {reward && (
          <Link href={`/rewards/${reward.rewardEventId}`} className="mt-1 inline-block text-sm font-semibold text-volt underline">
            New reward #{reward.rewardEventId} →
          </Link>
        )}
      </div>
      <button onClick={check} disabled={busy} className="btn">
        Check now
      </button>
    </div>
  );
}
