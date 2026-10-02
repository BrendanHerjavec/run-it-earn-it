import { readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseDotenv } from "dotenv";
import { z } from "zod";

/**
 * Central, validated view of the environment. Everything that affects money
 * (caps, kill switch, auto-buy) is read from here so there is exactly one
 * place to audit.
 */

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : ["1", "true", "yes", "on"].includes(v.toLowerCase())));

const dollars = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : Number(v)))
    .pipe(z.number().nonnegative());

const schema = z.object({
  NODE_ENV: z.string().default("development"),
  DATABASE_URL: z.string().default("pglite:./.data/pglite"),
  APP_PASSWORD: z.string().default(""),
  APP_BASE_URL: z.string().default("http://localhost:3000"),
  ANTHROPIC_API_KEY: z.string().default(""),
  ANTHROPIC_MODEL: z.string().default("claude-sonnet-5"),
  /** Needed only for organization-level API keys that aren't scoped to a workspace. */
  ANTHROPIC_WORKSPACE_ID: z.string().default(""),
  STRAVA_CLIENT_ID: z.string().default(""),
  STRAVA_CLIENT_SECRET: z.string().default(""),
  STRAVA_WEBHOOK_VERIFY_TOKEN: z.string().default(""),
  CROSSMINT_API_KEY: z.string().default(""),
  CROSSMINT_BASE_URL: z.string().default("https://www.crossmint.com"),
  RYE_API_KEY: z.string().default(""),
  RYE_BASE_URL: z.string().default("https://staging.api.rye.com"),
  NTFY_SERVER: z.string().default("https://ntfy.sh"),
  NTFY_TOPIC: z.string().default(""),
  NTFY_TOKEN: z.string().default(""),
  APPROVAL_SIGNING_SECRET: z.string().default(""),
  TOKEN_ENCRYPTION_KEY: z.string().default(""),
  CHECKOUT_PROVIDER: z.enum(["mock", "cart", "browser", "crossmint", "rye"]).default("cart"),
  /** Model for the local browser checkout agent. */
  BROWSER_AGENT_MODEL: z.string().default("claude-sonnet-5"),
  /** Chrome profile the checkout agent uses; sign in to your store here once. */
  SHOPPING_PROFILE_DIR: z.string().default(".data/shopping-profile"),
  /** Seconds between Claude's pick and the automatic purchase after "Sync runs". */
  SYNC_COUNTDOWN_S: dollars(10),
  PURCHASES_ENABLED: bool(false),
  AUTO_BUY: bool(false),
  DEMO_TOOLS_ENABLED: bool(true),
  MAX_ORDER_CAD: dollars(40),
  MAX_DAILY_CAD: dollars(60),
  MAX_WEEKLY_CAD: dollars(100),
  AUTO_BUY_MAX_CAD: dollars(15),
  MAX_RUN_SPEED_KMH: dollars(20),
  CRON_SECRET: z.string().default(""),
});

export type AppConfig = z.infer<typeof schema>;

let cached: AppConfig | null = null;

/**
 * This app runs on your own machine, so the project's .env.local wins over
 * machine-wide variables (e.g. an old ANTHROPIC_API_KEY set in Windows).
 * Next.js on its own does the opposite. Tests keep their own environment.
 */
function localOverrides(): Record<string, string> {
  if (process.env.NODE_ENV === "test") return {};
  try {
    const parsed = parseDotenv(readFileSync(path.join(process.cwd(), ".env.local")));
    return Object.fromEntries(Object.entries(parsed).filter(([, v]) => v !== ""));
  } catch {
    return {};
  }
}

export function config(): AppConfig {
  if (!cached) cached = schema.parse({ ...process.env, ...localOverrides() });
  return cached;
}

/** Tests mutate process.env and call this to pick up the change. */
export function resetConfigCache() {
  cached = null;
}

export const CURRENCY = "CAD" as const;

export { TIERS, TIER_MAX_CENTS, tierAllows, type Tier } from "./tiers";
