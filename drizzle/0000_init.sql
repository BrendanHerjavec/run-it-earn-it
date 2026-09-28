CREATE TYPE "public"."goal_type" AS ENUM('single_run_distance', 'weekly_distance', 'quest');--> statement-breakpoint
CREATE TYPE "public"."reward_status" AS ENUM('pending_agent', 'awaiting_approval', 'approved', 'checking_out', 'completed', 'failed', 'rejected', 'skipped_budget');--> statement-breakpoint
CREATE TYPE "public"."tier" AS ENUM('small', 'medium', 'large');--> statement-breakpoint
CREATE TABLE "activities" (
	"id" serial PRIMARY KEY NOT NULL,
	"strava_id" bigint NOT NULL,
	"source" text DEFAULT 'strava' NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"sport_type" text NOT NULL,
	"distance_m" double precision NOT NULL,
	"moving_time_s" integer NOT NULL,
	"average_speed_mps" double precision NOT NULL,
	"start_time" timestamp with time zone NOT NULL,
	"polyline" text,
	"flagged" boolean DEFAULT false NOT NULL,
	"flag_reason" text,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"reward_event_id" integer,
	"activity_id" integer,
	"kind" text NOT NULL,
	"message" text DEFAULT '' NOT NULL,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "goals" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"type" "goal_type" NOT NULL,
	"target_km" double precision,
	"lat" double precision,
	"lng" double precision,
	"radius_m" integer,
	"reward_tier" "tier" DEFAULT 'small' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "location_pings" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"lat" double precision NOT NULL,
	"lng" double precision NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reward_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"activity_id" integer NOT NULL,
	"goal_id" integer,
	"status" "reward_status" DEFAULT 'pending_agent' NOT NULL,
	"chosen_item_id" integer,
	"agent_message" text,
	"agent_transcript" jsonb,
	"provider" text,
	"provider_run_id" text,
	"live_view_url" text,
	"quoted_total_cents" integer,
	"total_charged_cents" integer,
	"receipt" jsonb,
	"failure_reason" text,
	"approval_token_hash" text,
	"approval_token_expires_at" timestamp with time zone,
	"approval_token_used_at" timestamp with time zone,
	"approved_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"max_order_cents" integer,
	"max_daily_cents" integer,
	"max_weekly_cents" integer,
	"auto_buy_max_cents" integer,
	"auto_buy" boolean DEFAULT false NOT NULL,
	"provider" text,
	"crossmint_buyer_profile_id" text,
	"crossmint_payment_method_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spend_ledger" (
	"id" serial PRIMARY KEY NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'CAD' NOT NULL,
	"reward_event_id" integer NOT NULL,
	"kind" text DEFAULT 'reserved' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spend_ledger_reward_event_id_unique" UNIQUE("reward_event_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text DEFAULT '' NOT NULL,
	"phone" text DEFAULT '' NOT NULL,
	"address_line1" text DEFAULT '' NOT NULL,
	"address_line2" text DEFAULT '' NOT NULL,
	"city" text DEFAULT '' NOT NULL,
	"province" text DEFAULT 'ON' NOT NULL,
	"postal_code" text DEFAULT '' NOT NULL,
	"country" text DEFAULT 'CA' NOT NULL,
	"timezone" text DEFAULT 'America/Toronto' NOT NULL,
	"strava_athlete_id" bigint,
	"strava_tokens_enc" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wishlist_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"product_url" text NOT NULL,
	"expected_price_cents" integer NOT NULL,
	"tier" "tier" NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "reward_events" ADD CONSTRAINT "reward_events_activity_id_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reward_events" ADD CONSTRAINT "reward_events_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reward_events" ADD CONSTRAINT "reward_events_chosen_item_id_wishlist_items_id_fk" FOREIGN KEY ("chosen_item_id") REFERENCES "public"."wishlist_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spend_ledger" ADD CONSTRAINT "spend_ledger_reward_event_id_reward_events_id_fk" FOREIGN KEY ("reward_event_id") REFERENCES "public"."reward_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "activities_strava_id_uq" ON "activities" USING btree ("strava_id");--> statement-breakpoint
CREATE INDEX "activities_start_idx" ON "activities" USING btree ("start_time");--> statement-breakpoint
CREATE INDEX "event_log_reward_idx" ON "event_log" USING btree ("reward_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reward_events_activity_uq" ON "reward_events" USING btree ("activity_id");