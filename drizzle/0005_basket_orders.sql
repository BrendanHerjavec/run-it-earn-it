CREATE TYPE "public"."order_status" AS ENUM('awaiting_approval', 'checking_out', 'completed', 'failed', 'rejected');--> statement-breakpoint
ALTER TYPE "public"."reward_status" ADD VALUE 'in_basket';--> statement-breakpoint
CREATE TABLE "orders" (
	"id" serial PRIMARY KEY NOT NULL,
	"challenge_id" integer NOT NULL,
	"window_start_key" text NOT NULL,
	"status" "order_status" DEFAULT 'awaiting_approval' NOT NULL,
	"auto_approve_at" timestamp with time zone,
	"provider" text,
	"provider_run_id" text,
	"quoted_total_cents" integer,
	"max_spend_cents" integer,
	"total_charged_cents" integer,
	"checkout_state" jsonb,
	"receipt" jsonb,
	"failure_reason" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "spend_ledger" ALTER COLUMN "reward_event_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "challenges" ADD COLUMN "basket_checkout" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "event_log" ADD COLUMN "order_id" integer;--> statement-breakpoint
ALTER TABLE "goals" ADD COLUMN "max_price_cents" integer;--> statement-breakpoint
ALTER TABLE "reward_events" ADD COLUMN "order_id" integer;--> statement-breakpoint
ALTER TABLE "spend_ledger" ADD COLUMN "order_id" integer;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_challenge_id_challenges_id_fk" FOREIGN KEY ("challenge_id") REFERENCES "public"."challenges"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "orders_challenge_window_uq" ON "orders" USING btree ("challenge_id","window_start_key");--> statement-breakpoint
ALTER TABLE "spend_ledger" ADD CONSTRAINT "spend_ledger_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "event_log_order_idx" ON "event_log" USING btree ("order_id");--> statement-breakpoint
ALTER TABLE "spend_ledger" ADD CONSTRAINT "spend_ledger_order_id_unique" UNIQUE("order_id");