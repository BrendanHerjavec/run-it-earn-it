import {
  bigint,
  boolean,
  doublePrecision,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

export const tierEnum = pgEnum("tier", ["small", "medium", "large"]);
export const goalTypeEnum = pgEnum("goal_type", ["single_run_distance", "weekly_distance", "quest"]);
export const rewardStatusEnum = pgEnum("reward_status", [
  "pending_agent",
  "awaiting_approval",
  "approved",
  "checking_out",
  "completed",
  "failed",
  "rejected",
  "skipped_budget",
]);

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

/** Single-user app: exactly one row. */
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().default(""),
  phone: text("phone").notNull().default(""),
  addressLine1: text("address_line1").notNull().default(""),
  addressLine2: text("address_line2").notNull().default(""),
  city: text("city").notNull().default(""),
  province: text("province").notNull().default("ON"),
  postalCode: text("postal_code").notNull().default(""),
  country: text("country").notNull().default("CA"),
  timezone: text("timezone").notNull().default("America/Toronto"),
  stravaAthleteId: bigint("strava_athlete_id", { mode: "number" }),
  /** AES-256-GCM encrypted JSON of { accessToken, refreshToken, expiresAt }. */
  stravaTokensEnc: text("strava_tokens_enc"),
  ...timestamps,
});

/**
 * UI-editable settings. Env values are hard ceilings: the effective cap is
 * min(env, settings), so the UI can tighten limits but never loosen them.
 */
export const settings = pgTable("settings", {
  id: integer("id").primaryKey().default(1),
  maxOrderCents: integer("max_order_cents"),
  maxDailyCents: integer("max_daily_cents"),
  maxWeeklyCents: integer("max_weekly_cents"),
  autoBuyMaxCents: integer("auto_buy_max_cents"),
  /** When false (default) every purchase needs a tap on Approve. Also requires AUTO_BUY env. */
  autoBuy: boolean("auto_buy").notNull().default(false),
  provider: text("provider").$type<"mock" | "crossmint" | "rye">(),
  crossmintBuyerProfileId: text("crossmint_buyer_profile_id"),
  crossmintPaymentMethodId: text("crossmint_payment_method_id"),
  ...timestamps,
});

export const goals = pgTable("goals", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  type: goalTypeEnum("type").notNull(),
  targetKm: doublePrecision("target_km"),
  lat: doublePrecision("lat"),
  lng: doublePrecision("lng"),
  radiusM: integer("radius_m"),
  rewardTier: tierEnum("reward_tier").notNull().default("small"),
  active: boolean("active").notNull().default(true),
  ...timestamps,
});

export const wishlistItems = pgTable("wishlist_items", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  productUrl: text("product_url").notNull(),
  expectedPriceCents: integer("expected_price_cents").notNull(),
  tier: tierEnum("tier").notNull(),
  notes: text("notes").notNull().default(""),
  active: boolean("active").notNull().default(true),
  ...timestamps,
});

export const activities = pgTable(
  "activities",
  {
    id: serial("id").primaryKey(),
    /** Strava activity ID. Simulated runs use negative IDs so they can never collide. */
    stravaId: bigint("strava_id", { mode: "number" }).notNull(),
    source: text("source").$type<"strava" | "simulated">().notNull().default("strava"),
    name: text("name").notNull().default(""),
    sportType: text("sport_type").notNull(),
    distanceM: doublePrecision("distance_m").notNull(),
    movingTimeS: integer("moving_time_s").notNull(),
    averageSpeedMps: doublePrecision("average_speed_mps").notNull(),
    startTime: timestamp("start_time", { withTimezone: true }).notNull(),
    polyline: text("polyline"),
    flagged: boolean("flagged").notNull().default(false),
    flagReason: text("flag_reason"),
    raw: jsonb("raw"),
    ...timestamps,
  },
  (t) => [uniqueIndex("activities_strava_id_uq").on(t.stravaId), index("activities_start_idx").on(t.startTime)],
);

export const rewardEvents = pgTable(
  "reward_events",
  {
    id: serial("id").primaryKey(),
    /** Unique: one reward per activity. This is the idempotency backstop for webhook retries. */
    activityId: integer("activity_id")
      .notNull()
      .references(() => activities.id),
    goalId: integer("goal_id").references(() => goals.id),
    status: rewardStatusEnum("status").notNull().default("pending_agent"),
    chosenItemId: integer("chosen_item_id").references(() => wishlistItems.id),
    agentMessage: text("agent_message"),
    agentTranscript: jsonb("agent_transcript"),
    provider: text("provider"),
    providerRunId: text("provider_run_id"),
    liveViewUrl: text("live_view_url"),
    quotedTotalCents: integer("quoted_total_cents"),
    totalChargedCents: integer("total_charged_cents"),
    receipt: jsonb("receipt"),
    failureReason: text("failure_reason"),
    approvalTokenHash: text("approval_token_hash"),
    approvalTokenExpiresAt: timestamp("approval_token_expires_at", { withTimezone: true }),
    approvalTokenUsedAt: timestamp("approval_token_used_at", { withTimezone: true }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    /** "notification" | "dashboard" | "auto" */
    approvedVia: text("approved_via"),
    /** Set when an agent run claims this reward, so two agents never run for one reward. */
    agentStartedAt: timestamp("agent_started_at", { withTimezone: true }),
    /** Hard spend cap handed to the provider (and reserved in the ledger). */
    maxSpendCents: integer("max_spend_cents"),
    /** Latest provider status snapshot, for the live dashboard. */
    checkoutState: jsonb("checkout_state"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [uniqueIndex("reward_events_activity_uq").on(t.activityId)],
);

export const spendLedger = pgTable("spend_ledger", {
  id: serial("id").primaryKey(),
  amountCents: integer("amount_cents").notNull(),
  currency: text("currency").notNull().default("CAD"),
  /** Unique so a reward can only ever be charged to the ledger once. */
  rewardEventId: integer("reward_event_id")
    .notNull()
    .unique()
    .references(() => rewardEvents.id),
  /** "reserved" while a checkout is in flight, "settled" once charged, "released" if it failed. */
  kind: text("kind").$type<"reserved" | "settled" | "released">().notNull().default("reserved"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Append-only audit log: agent tool calls, provider requests/responses (redacted), state changes. */
export const eventLog = pgTable(
  "event_log",
  {
    id: serial("id").primaryKey(),
    rewardEventId: integer("reward_event_id"),
    activityId: integer("activity_id"),
    kind: text("kind").notNull(),
    message: text("message").notNull().default(""),
    data: jsonb("data"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("event_log_reward_idx").on(t.rewardEventId)],
);

/**
 * v2 placeholder: a future Expo app will post live GPS pings here for in-run
 * quest proximity alerts. Unused in v1.
 */
export const locationPings = pgTable("location_pings", {
  id: serial("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  lat: doublePrecision("lat").notNull(),
  lng: doublePrecision("lng").notNull(),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type User = typeof users.$inferSelect;
export type Settings = typeof settings.$inferSelect;
export type Goal = typeof goals.$inferSelect;
export type WishlistItem = typeof wishlistItems.$inferSelect;
export type Activity = typeof activities.$inferSelect;
export type RewardEvent = typeof rewardEvents.$inferSelect;
export type RewardStatus = RewardEvent["status"];
