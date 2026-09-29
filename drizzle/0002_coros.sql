ALTER TABLE "activities" ALTER COLUMN "strava_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "coros_client_id" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "coros_redirect_uri" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "coros_tokens_enc" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "coros_connected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "coros_last_seen_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "activities_external_id_uq" ON "activities" USING btree ("external_id");