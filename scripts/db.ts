/**
 * npm run db:migrate   apply migrations to DATABASE_URL (Postgres or PGlite)
 * npm run db:seed      insert sample user / goal / wishlist if the DB is empty
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
loadEnv();

async function main() {
  const cmd = process.argv[2];
  const url = process.env.DATABASE_URL ?? "pglite:./.data/pglite";

  if (url.startsWith("pglite:")) {
    // getDb() migrates and seeds PGlite automatically.
    const { getDb } = await import("../src/db");
    await getDb();
    console.log(`PGlite database ready (${url}).`);
    return;
  }

  const postgres = (await import("postgres")).default;
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const { migrate } = await import("drizzle-orm/postgres-js/migrator");
  const schema = await import("../src/db/schema");
  const client = postgres(url, { max: 1 });
  const db = drizzle(client, { schema });
  if (cmd === "migrate") {
    await migrate(db, { migrationsFolder: "drizzle" });
    console.log("Migrations applied.");
  } else if (cmd === "seed") {
    const { seedIfEmpty } = await import("../src/db/seed");
    console.log((await seedIfEmpty(db)) ? "Seeded." : "Database already has data; nothing to do.");
  } else {
    console.error("usage: tsx scripts/db.ts migrate|seed");
    process.exitCode = 1;
  }
  await client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
