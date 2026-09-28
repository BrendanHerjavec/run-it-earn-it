import path from "node:path";
import { mkdirSync } from "node:fs";
import { drizzle as drizzlePostgres, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { config } from "@/lib/config";
import * as schema from "./schema";

/**
 * DATABASE_URL formats:
 *   postgres://...            real Postgres (Neon / Supabase) — use in production
 *   pglite:./.data/pglite     embedded Postgres on disk — zero-setup local dev
 *   pglite:memory             embedded, in-memory — tests
 *
 * PGlite databases are migrated (and seeded) automatically on first use.
 * Real Postgres is migrated with `npm run db:migrate`.
 */
export type DB = PostgresJsDatabase<typeof schema>;

const MIGRATIONS = path.join(process.cwd(), "drizzle");

type Holder = { dbPromise?: Promise<DB> };
const g = globalThis as unknown as { __runItEarnIt?: Holder };
const holder: Holder = (g.__runItEarnIt ??= {});

async function open(url: string): Promise<DB> {
  if (url.startsWith("pglite:")) {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    const target = url.slice("pglite:".length);
    let client;
    if (target === "memory") {
      client = new PGlite();
    } else {
      mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
      client = new PGlite(path.resolve(target));
    }
    const db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS });
    // Drizzle's query surface is identical across drivers; treat both as one type.
    const typed = db as unknown as DB;
    if (target !== "memory") {
      const { seedIfEmpty } = await import("./seed");
      await seedIfEmpty(typed);
    }
    return typed;
  }
  const postgres = (await import("postgres")).default;
  const client = postgres(url, { prepare: false, max: 5 });
  return drizzlePostgres(client, { schema });
}

export function getDb(): Promise<DB> {
  holder.dbPromise ??= open(config().DATABASE_URL);
  return holder.dbPromise;
}

/** Tests: swap in a fresh database. */
export function setDbForTests(db: Promise<DB> | undefined) {
  holder.dbPromise = db;
}

export { schema };
