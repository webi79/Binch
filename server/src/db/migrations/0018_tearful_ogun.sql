DROP INDEX IF EXISTS "uq_price_alerts_device_route";--> statement-breakpoint
ALTER TABLE "price_alerts" ADD COLUMN "return_date" varchar(10) DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_price_alerts_device_route" ON "price_alerts" USING btree ("push_token_id","mode","origin","destination","depart_date","return_date");