DROP INDEX IF EXISTS "uq_price_alerts_device_route";--> statement-breakpoint
ALTER TABLE "price_alerts" ADD COLUMN "passengers" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "price_alerts" ADD COLUMN "travel_class" varchar(60) DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_price_alerts_device_route" ON "price_alerts" USING btree ("push_token_id","mode","origin","destination","depart_date","return_date","passengers","travel_class","currency");