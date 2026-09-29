import { AppShell, PageTitle } from "@/components/AppShell";
import { config } from "@/lib/config";
import { getEffectiveSettings, getUser } from "@/lib/settings";
import { formatCad } from "@/lib/format";
import { LimitsForm, ProfileForm } from "./SettingsForms";
import { disconnectCoros, disconnectStrava } from "./actions";

export const dynamic = "force-dynamic";

function Flag({ on, label, dangerWhenOn }: { on: boolean; label: string; dangerWhenOn?: boolean }) {
  const cls = on ? (dangerWhenOn ? "border-bad/50 text-bad" : "border-good/50 text-good") : "text-muted";
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-line bg-surface-2 px-4 py-3">
      <span className="font-mono text-sm">{label}</span>
      <span className={`pill ${cls}`}>{on ? "ON" : "OFF"}</span>
    </div>
  );
}

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ strava?: string; coros?: string }> }) {
  const [s, user, { strava, coros }] = await Promise.all([getEffectiveSettings(), getUser(), searchParams]);
  const c = config();

  return (
    <AppShell>
      <PageTitle eyebrow="Guardrails" title="Settings" />

      <div className="grid gap-8">
        <section className="card">
          <h2 className="mb-4 text-lg font-semibold">Safety switches (env, read-only)</h2>
          <div className="grid gap-3 sm:grid-cols-3">
            <Flag on={s.purchasesEnabled} label="PURCHASES_ENABLED" dangerWhenOn />
            <Flag on={s.env.autoBuy} label="AUTO_BUY" dangerWhenOn />
            <Flag on={c.DEMO_TOOLS_ENABLED} label="DEMO_TOOLS_ENABLED" />
          </div>
          <p className="mt-3 text-sm text-muted">
            {s.purchasesEnabled
              ? "Real providers can be called. Every purchase is still bounded by the caps below."
              : "Kill switch engaged: real checkout providers are never called. Rewards run through the mock provider."}
          </p>
          <div className="mt-5 grid gap-3 text-sm sm:grid-cols-4">
            <div>
              <p className="eyebrow">Effective per order</p>
              <p className="text-2xl font-bold tabular-nums">{formatCad(s.maxOrderCents)}</p>
            </div>
            <div>
              <p className="eyebrow">Per day</p>
              <p className="text-2xl font-bold tabular-nums">{formatCad(s.maxDailyCents)}</p>
            </div>
            <div>
              <p className="eyebrow">Per week</p>
              <p className="text-2xl font-bold tabular-nums">{formatCad(s.maxWeeklyCents)}</p>
            </div>
            <div>
              <p className="eyebrow">Approval mode</p>
              <p className="text-2xl font-bold">{s.autoBuy ? `Auto ≤ ${formatCad(s.autoBuyMaxCents)}` : "Approve each"}</p>
            </div>
          </div>
        </section>

        <section className="card">
          <h2 className="mb-4 text-lg font-semibold">Limits & provider</h2>
          <LimitsForm env={s.env} row={s.row} />
        </section>

        <section className="card">
          <h2 className="mb-1 text-lg font-semibold">COROS</h2>
          <p className="mb-3 text-sm text-muted">
            Runs come from your COROS account through COROS&apos;s official MCP server. Free, no developer approval. New runs are picked up by polling.
          </p>
          {coros === "connected" && <p className="mb-2 text-sm text-good">COROS connected.</p>}
          {coros === "error" && <p className="mb-2 text-sm text-bad">COROS connection failed. Check the event log.</p>}
          {user.corosTokensEnc ? (
            <div className="flex flex-wrap items-center gap-4">
              <p className="text-muted">
                Connected {user.corosConnectedAt?.toLocaleDateString("en-CA", { timeZone: user.timezone })}
              </p>
              <a href="/api/coros/connect" className="btn">Reconnect</a>
              <form action={disconnectCoros}>
                <button className="btn-danger">Disconnect</button>
              </form>
            </div>
          ) : (
            <a href="/api/coros/connect" className="btn-primary">Connect COROS</a>
          )}
        </section>

        <section className="card">
          <h2 className="mb-1 text-lg font-semibold">Strava <span className="text-sm font-normal text-muted">(needs a Strava subscription since June 2026)</span></h2>
          {strava === "connected" && <p className="mb-2 text-sm text-good">Strava connected.</p>}
          {strava === "error" && <p className="mb-2 text-sm text-bad">Strava connection failed. Check the server logs.</p>}
          {user.stravaAthleteId ? (
            <div className="flex flex-wrap items-center gap-4">
              <p className="text-muted">
                Connected as athlete <span className="font-mono text-fg">{user.stravaAthleteId}</span>
              </p>
              <form action={disconnectStrava}>
                <button className="btn-danger">Disconnect</button>
              </form>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-4">
              <p className="text-muted">Not connected.</p>
              {c.STRAVA_CLIENT_ID ? (
                <a href="/api/strava/connect" className="btn-primary" style={{ background: "#fc4c02", color: "white" }}>
                  Connect with Strava
                </a>
              ) : (
                <span className="text-sm text-warn">Set STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET to connect.</span>
              )}
            </div>
          )}
        </section>

        <section className="card">
          <h2 className="mb-1 text-lg font-semibold">Profile & shipping</h2>
          <p className="mb-4 text-sm text-muted">Used to build the checkout provider&apos;s buyer profile. Province uses the 2-letter code (ON).</p>
          <ProfileForm user={user} />
        </section>
      </div>
    </AppShell>
  );
}
