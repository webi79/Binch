DROP INDEX IF EXISTS "uq_price_alerts_device_route";--> statement-breakpoint
ALTER TABLE "price_alerts" ADD COLUMN "fare_profile" varchar(40) DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "search_requests" ADD COLUMN "fare_profile" varchar(40);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_price_alerts_device_route" ON "price_alerts" USING btree ("push_token_id","mode","origin","destination","depart_date","return_date","passengers","travel_class","currency","fare_profile");