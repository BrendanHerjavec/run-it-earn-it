# Run It, Earn It

Finish a run that hits a goal → a Claude agent picks a reward from your wishlist → you tap **Approve** on your phone → a checkout agent buys it and ships it home.

Single-user app. Next.js 16 (App Router) + TypeScript + Drizzle/Postgres, deployed on Vercel.

> **Status:** Phases 1–2 are done: scaffold, auth, settings, wishlist, goals, Strava OAuth and webhook, rules engine, and Simulate run. The agent, notifications and checkout providers land in Phases 3–4.

## How a run becomes a reward

1. Strava POSTs `activity:create` to `/api/strava/webhook`. We reply 200 immediately and process the event in `after()`.
2. Fetch the activity. Store it once: `strava_id` is unique, and webhook retries reuse the stored row instead of calling Strava again.
3. Guardrails: `sport_type` must be `Run` or `TrailRun`. An average above `MAX_RUN_SPEED_KMH` (20) is **flagged** and never rewarded.
4. Rules:
   - **Single-run distance:** every qualifying run earns it.
   - **Weekly distance:** earned by the run that crosses the target, once per local week (Monday start, in your timezone).
   - **Quest:** earned the first time the route passes within the radius. We check the distance to each *segment* of the polyline, not just the recorded points.
5. At most one reward per activity (highest tier wins). If no wishlist item fits the remaining budget and tier, the reward is `skipped_budget`. Otherwise it's `pending_agent`, and Phase 3 hands it to Claude.

## Strava setup

1. Go to https://www.strava.com/settings/api and create an app. Set **Authorization Callback Domain** to `localhost` for local dev, or your Vercel domain in production.
2. Put the Client ID and Client Secret in `.env.local` (`STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET`).
3. Restart `npm run dev` → **Settings → Connect with Strava**. The app asks for `read,activity:read_all` so private runs count too.
4. Register the webhook. This needs a public https URL; Strava can't reach localhost. Deploy first (Phase 5), or tunnel with `cloudflared tunnel --url http://localhost:3000`, then run:

```bash
npm run strava:webhook -- create https://YOUR-PUBLIC-URL/api/strava/webhook
```

`npm run strava:webhook -- view` / `-- delete <id>` manage it. Strava allows one subscription per app.

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
