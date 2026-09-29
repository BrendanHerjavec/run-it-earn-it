import { eq } from "drizzle-orm";
import { getDb, type DB } from "@/db";
import { settings, users, type Settings, type User } from "@/db/schema";
import { config } from "./config";

export type EffectiveSettings = {
  maxOrderCents: number;
  maxDailyCents: number;
  maxWeeklyCents: number;
  autoBuyMaxCents: number;
  /** True only if BOTH the AUTO_BUY env flag and the settings toggle are on. */
  autoBuy: boolean;
  provider: "mock" | "browser" | "crossmint" | "rye";
  /** Env-only kill switch. When false the real providers are never called. */
  purchasesEnabled: boolean;
  env: {
    maxOrderCents: number;
    maxDailyCents: number;
    maxWeeklyCents: number;
    autoBuyMaxCents: number;
    autoBuy: boolean;
    provider: "mock" | "browser" | "crossmint" | "rye";
  };
  row: Settings;
};

const cents = (dollars: number) => Math.round(dollars * 100);

/** Env caps are ceilings: a settings value can only make a cap tighter. */
function tighter(envCents: number, dbCents: number | null): number {
  return dbCents == null ? envCents : Math.min(envCents, dbCents);
}

export async function getSettingsRow(db?: DB): Promise<Settings> {
  db ??= await getDb();
  const rows = await db.select().from(settings).where(eq(settings.id, 1));
  if (rows[0]) return rows[0];
  const [row] = await db.insert(settings).values({ id: 1 }).onConflictDoNothing().returning();
  return row ?? (await db.select().from(settings).where(eq(settings.id, 1)))[0];
}

export async function getEffectiveSettings(db?: DB): Promise<EffectiveSettings> {
  const c = config();
  const row = await getSettingsRow(db);
  const env = {
    maxOrderCents: cents(c.MAX_ORDER_CAD),
    maxDailyCents: cents(c.MAX_DAILY_CAD),
    maxWeeklyCents: cents(c.MAX_WEEKLY_CAD),
    autoBuyMaxCents: cents(c.AUTO_BUY_MAX_CAD),
    autoBuy: c.AUTO_BUY,
    provider: c.CHECKOUT_PROVIDER,
  };
  const maxOrderCents = tighter(env.maxOrderCents, row.maxOrderCents);
  return {
    maxOrderCents,
    maxDailyCents: tighter(env.maxDailyCents, row.maxDailyCents),
    maxWeeklyCents: tighter(env.maxWeeklyCents, row.maxWeeklyCents),
    autoBuyMaxCents: Math.min(tighter(env.autoBuyMaxCents, row.autoBuyMaxCents), maxOrderCents),
    autoBuy: env.autoBuy && row.autoBuy,
    provider: row.provider ?? env.provider,
    purchasesEnabled: c.PURCHASES_ENABLED,
    env,
    row,
  };
}

export async function getUser(db?: DB): Promise<User> {
  db ??= await getDb();
  const [u] = await db.select().from(users).orderBy(users.id).limit(1);
  if (u) return u;
  const [created] = await db.insert(users).values({ name: "Runner" }).returning();
  return created;
}
