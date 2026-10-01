CREATE TABLE "challenges" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"starts_on" text NOT NULL,
	"length_days" integer DEFAULT 7 NOT NULL,
	"repeats" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "reward_events_activity_uq";--> statement-breakpoint
ALTER TABLE "goals" ADD COLUMN "challenge_id" integer;--> statement-breakpoint
ALTER TABLE "goals" ADD COLUMN "reward_item_id" integer;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_challenge_id_challenges_id_fk" FOREIGN KEY ("challenge_id") REFERENCES "public"."challenges"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_reward_item_id_wishlist_items_id_fk" FOREIGN KEY ("reward_item_id") REFERENCES "public"."wishlist_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reward_events_activity_goal_uq" ON "reward_events" USING btree ("activity_id","goal_id");