# Run It, Earn It

Finish a run that hits a goal → a Claude agent picks a reward from your wishlist → you tap **Approve** on your phone → a checkout agent buys it and ships it home.

Single-user app. Next.js 16 (App Router) + TypeScript + Drizzle/Postgres, deployed on Vercel.

> **Status:** Phases 1–3 are done. The full pipeline (Strava or Simulate run → Claude picks → phone Approve → checkout → receipt) works end to end with the **mock** checkout. Real checkout providers are Phase 4.

## How a run becomes a reward

1. Strava POSTs `activity:create` to `/api/strava/webhook`. We reply 200 immediately and process the event in `after()`.
2. Fetch the activity. Store it once: `strava_id` is unique, and webhook retries reuse the stored row instead of calling Strava again.
3. Guardrails: `sport_type` must be `Run` or `TrailRun`. An average above `MAX_RUN_SPEED_KMH` (20) is **flagged** and never rewarded.
4. Rules:
   - **Single-run distance:** every qualifying run earns it.
   - **Weekly distance:** earned by the run that crosses the target, once per local week (Monday start, in your timezone).
   - **Quest:** earned the first time the route passes within the radius. We check the distance to each *segment* of the polyline, not just the recorded points.
5. At most one reward per activity (highest tier wins). If no wishlist item fits the remaining budget and tier, the reward is `skipped_budget`. Otherwise it's `pending_agent`.
6. **Claude** (`claude-sonnet-5`, adaptive thinking) calls `get_run_summary`, `get_budget_status` and `list_wishlist`, then `choose_reward(item_id, message)`. The server re-checks the item, tier and price including tax, and returns an error if the choice isn't allowed, so Claude picks again. The full transcript, including summarized thinking, is saved for replay.
7. **ntfy** pushes "Claude picked X, Approve?" with **Approve** / **Skip** buttons. The links are signed, bound to the reward, single-use and expire in 2 hours.
8. **Approve** re-checks every cap under a lock, reserves a hard cap (quote + 10%, never above what's left) in the spend ledger, and starts the checkout. The dashboard shows live progress; the ledger settles to the actual charge, or is released if the checkout fails.

```
pending_agent → awaiting_approval → approved → checking_out → completed
      ↓                ↓                             ↓
   failed          rejected (Skip)                 failed
```

## COROS setup (recommended source of runs)

Strava's API needs a paid Strava subscription since June 2026, so runs come from **COROS's official MCP server** by default. It's free and needs no developer approval.

1. **Settings → Connect COROS**, then sign in on COROS's own page. The app registers itself as an OAuth client automatically (PKCE, no secret) and stores only an encrypted token. Your COROS password never touches this app.
2. New runs are found by **polling** (COROS has no webhooks for personal apps):
   - While the home dashboard is open, it checks every minute. There's also a **Check now** button.
   - For when the dashboard is closed, point a free external scheduler (e.g. [cron-job.org](https://cron-job.org)) at `POST https://YOUR-APP/api/coros/poll` every 1–2 minutes, with header `Authorization: Bearer <CRON_SECRET>`. Vercel's free cron only runs daily.
3. Each new run's FIT file (full GPS, so quests work) is downloaded and sent through the same pipeline as Strava. COROS allows 50 FIT downloads a day; past that, the run is still counted from its summary, without GPS.
4. The first sync after connecting records a starting point: runs from before you connected never earn rewards.

## Strava setup (optional, needs a Strava subscription)

1. Go to https://www.strava.com/settings/api and create an app. Set **Authorization Callback Domain** to `localhost` for local dev, or your Vercel domain in production.
2. Put the Client ID and Client Secret in `.env.local` (`STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET`).
3. Restart `npm run dev` → **Settings → Connect with Strava**. The app asks for `read,activity:read_all` so private runs count too.
4. Register the webhook. This needs a public https URL; Strava can't reach localhost. Deploy first (Phase 5), or tunnel with `cloudflared tunnel --url http://localhost:3000`, then run:

```bash
npm run strava:webhook -- create https://YOUR-PUBLIC-URL/api/strava/webhook
```

`npm run strava:webhook -- view` / `-- delete <id>` manage it. Strava allows one subscription per app.

## Phone notifications (ntfy)

1. Install the **ntfy** app (iOS / Android).
2. Pick a long, unguessable topic name, e.g. `runny-$(openssl rand -hex 8)`. Anyone who knows it can read your notifications.
3. Subscribe to that topic in the app and set `NTFY_TOPIC` in `.env.local`.
4. The Approve button makes your **phone** call `APP_BASE_URL`, so it only works once the app has a public URL (Vercel, or a tunnel). Until then, approve from the reward page on the dashboard.

## Filming without running

With `DEMO_TOOLS_ENABLED=true`, the home page has a **Simulate run** panel. Pick a distance, pace and type, and optionally route it through a quest. It builds a Strava-shaped activity (negative ID, real encoded polyline) and runs it through the same pipeline. Try a 2:00 /km pace to demo the speed flag.

## Quick start (local)

```bash
npm install
cp .env.example .env.local   # then fill in APP_PASSWORD and the two secrets
npm run dev
```

Open http://localhost:3000 and sign in with `APP_PASSWORD`.

With the default `DATABASE_URL=pglite:./.data/pglite`, an embedded Postgres runs inside the Node process and is migrated and seeded (sample wishlist plus a 5 km goal) on first request. You don't need a database server for local dev.

Generate secrets with:

```bash
openssl rand -hex 32
```

## Production database (Neon or Supabase)

1. Create a Postgres database and copy its connection string into `DATABASE_URL`.
2. `npm run db:migrate`, then `npm run db:seed` (the seed only runs if the DB is empty).

After changing `src/db/schema.ts`, run `npm run db:generate` to create a new migration in `drizzle/`.

## Guardrails (enforced in code)

| Control | Where |
|---|---|
| `PURCHASES_ENABLED=false` kill switch: real providers are never called | env only, read-only in UI |
| Per-order / daily / weekly caps (CAD) | env = ceiling; `/settings` can only tighten |
| Auto-buy needs `AUTO_BUY=true` **and** the settings toggle, and only under `AUTO_BUY_MAX_CAD` | env + settings |
| One reward per activity | unique index on `reward_events.activity_id` |
| One ledger charge per reward | unique index on `spend_ledger.reward_event_id` |
| Strava tokens encrypted at rest (AES-256-GCM) | `src/lib/crypto.ts` |
| Claude can only pick active wishlist items within tier and budget | validated in `choose_reward`, not just the prompt |
| Caps re-checked at approval, with a hard cap handed to the provider | `approveReward` in `src/lib/rewards.ts` |
| Approve links: HMAC-signed, single-use, 2 h expiry, GET only shows a confirm button | `src/lib/approval.ts` |
| Every agent tool call, provider call and state change is logged (secrets redacted) | `event_log` table |

## Scripts

| | |
|---|---|
| `npm run dev` | dev server |
| `npm test` | unit + e2e tests (Vitest, in-memory PGlite) |
| `npm run strava:webhook -- view|create|delete` | manage the Strava push subscription |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run db:generate` / `db:migrate` / `db:seed` | Drizzle migrations |

## Layout

```
src/
  app/                 pages + route handlers
    api/auth/          password login/logout
    goals/ wishlist/ settings/
  components/          AppShell, QuestMap (Leaflet)
  db/                  schema, connection (Postgres or PGlite), seed
  lib/                 config (env), auth, crypto, settings, stats, time
  proxy.ts             auth gate (Next 16's renamed middleware)
drizzle/               SQL migrations
scripts/db.ts          migrate / seed CLI
```
