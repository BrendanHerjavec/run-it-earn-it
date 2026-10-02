ALTER TABLE "challenges" ADD COLUMN "shop_url" text;--> statement-breakpoint
ALTER TABLE "challenges" ADD COLUMN "shop_tag" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "challenges" ADD COLUMN "free_shipping_cents" integer;--> statement-breakpoint
ALTER TABLE "wishlist_items" ADD COLUMN "source" text DEFAULT 'wishlist' NOT NULL;