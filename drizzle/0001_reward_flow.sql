ALTER TABLE "reward_events" ADD COLUMN "approved_via" text;--> statement-breakpoint
ALTER TABLE "reward_events" ADD COLUMN "agent_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reward_events" ADD COLUMN "max_spend_cents" integer;--> statement-breakpoint
ALTER TABLE "reward_events" ADD COLUMN "checkout_state" jsonb;