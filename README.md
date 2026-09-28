# Run It, Earn It

Finish a run that hits a goal → a Claude agent picks a reward from your wishlist → you tap **Approve** on your phone → a checkout agent buys it and ships it home.

Single-user app. Next.js 16 (App Router) + TypeScript + Drizzle/Postgres, deployed on Vercel.

> **Status:** Phase 1 (scaffold, auth, settings, wishlist, goals) is done. Strava, the agent, notifications and checkout providers land in Phases 2–4.

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
