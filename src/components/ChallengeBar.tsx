import Link from "next/link";
import type { ChallengeProgress } from "@/lib/challenges";
import { formatCad, formatKm } from "@/lib/format";
import { checkoutBasketNow } from "@/app/basket-actions";

/** Running total with milestone markers that light up as they unlock. */
export function ChallengeBar({ p, timeZone }: { p: ChallengeProgress; timeZone: string }) {
  const ms = p.milestones.filter((m) => m.active);
  const maxKm = Math.max(1, ...ms.map((m) => m.km));
  const km = p.totalM / 1000;
  const pct = Math.min(100, (km / maxKm) * 100);
  const fmt = (d: Date) => d.toLocaleDateString("en-CA", { timeZone, month: "short", day: "numeric" });
  const next = ms.find((m) => !m.unlocked && km < m.km);
  const freeShip = p.challenge.freeShippingCents;
  const short = p.basket && freeShip != null ? Math.max(0, freeShip - p.basket.subtotalCents) : 0;
  const ordersWhen = p.window ? `orders on your first Sync after ${fmt(new Date(p.window.end.getTime() - 1))}` : "";

  return (
    <div className="card">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="eyebrow">Challenge</p>
          <p className="mt-1 text-xl font-bold">{p.challenge.name}</p>
        </div>
        <p className="text-sm text-muted">
          {p.window
            ? `${fmt(p.window.start)} → ${fmt(new Date(p.window.end.getTime() - 1))}`
            : "Not running right now"}
        </p>
      </div>

      <p className="mt-4 text-4xl font-black tabular-nums sm:text-5xl">
        {formatKm(p.totalM)} <span className="text-xl font-semibold text-muted">/ {maxKm} km</span>
      </p>

      <div className="relative mb-12 mt-5 h-3 rounded-full bg-surface-2">
        <div className="h-full rounded-full bg-volt transition-all duration-700" style={{ width: `${pct}%` }} />
        {ms.map((m) => {
          const left = (m.km / maxKm) * 100;
          const inner = (
            <>
              <span
                className={`block size-5 rounded-full border-2 ${m.unlocked ? "border-volt bg-volt" : "border-line bg-surface"}`}
                title={m.itemTitle ?? (m.maxPriceCents ? `up to ${formatCad(m.maxPriceCents)}` : `${m.tier} reward`)}
              />
              <span className={`mt-1 block whitespace-nowrap text-xs font-semibold ${m.unlocked ? "text-volt" : "text-muted"}`}>
                {m.km} km{m.unlocked ? " ✓" : ""}
              </span>
              {m.maxPriceCents != null && <span className="block text-[11px] text-muted">≤ {formatCad(m.maxPriceCents)}</span>}
            </>
          );
          return (
            <div key={m.goalId} className="absolute top-1/2 flex -translate-y-[10px] flex-col items-center" style={{ left: `calc(${left}% - 10px)` }}>
              {m.rewardEventId ? <Link href={`/rewards/${m.rewardEventId}`}>{inner}</Link> : inner}
            </div>
          );
        })}
      </div>

      {p.basket && (
        <div className="mt-6 rounded-xl border border-line bg-surface-2 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="eyebrow">This week&apos;s basket · one order</p>
              <p className="mt-1 font-semibold">
                {p.basket.titles.length ? p.basket.titles.join(" + ") : "Empty so far: hit a milestone to add a reward"}
              </p>
              {p.basket.titles.length > 0 && (
                <p className="text-sm text-muted tabular-nums">
                  {formatCad(p.basket.subtotalCents)}
                  {short > 0
                    ? ` · ${formatCad(short)} more for free shipping (${formatCad(freeShip!)}); until then it rolls into next week`
                    : `${freeShip != null ? " · free shipping ✓" : ""}${ordersWhen ? ` · ${ordersWhen}` : ""}`}
                </p>
              )}
              {p.challenge.shopUrl && (
                <p className="text-sm text-muted">
                  Claude shops{" "}
                  <a href={p.challenge.shopUrl} target="_blank" rel="noreferrer" className="underline">
                    {new URL(p.challenge.shopUrl).hostname.replace(/^www./, "")}
                  </a>
                  {p.challenge.shopTag ? ` (${p.challenge.shopTag})` : ""}
                </p>
              )}
            </div>
            {p.basket.order ? (
              <Link href={`/orders/${p.basket.order.id}`} className="btn-primary">
                Order: {p.basket.order.status.replaceAll("_", " ")} →
              </Link>
            ) : (
              p.basket.titles.length > 0 && (
                <form action={checkoutBasketNow}>
                  <input type="hidden" name="challengeId" value={p.challenge.id} />
                  <button className="btn">Check out now</button>
                </form>
              )
            )}
          </div>
        </div>
      )}

      <p className="mt-4 text-sm text-muted">
        {next
          ? `${(next.km - km).toFixed(1)} km to the ${next.km} km reward${next.itemTitle ? `: ${next.itemTitle}` : ""}`
          : ms.length
            ? "Every milestone unlocked. Nice work."
            : "No milestones."}
      </p>
    </div>
  );
}
