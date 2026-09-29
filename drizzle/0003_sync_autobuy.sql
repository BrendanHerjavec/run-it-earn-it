ALTER TABLE "reward_events" ADD COLUMN "auto_approve" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "reward_events" ADD COLUMN "auto_approve_at" timestamp with time zone;