ALTER TABLE "locations" ALTER COLUMN "code" SET DATA TYPE varchar(64);--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "latitude" numeric(9, 6);--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "longitude" numeric(9, 6);--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "hafas_id" varchar(16);--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "source" varchar(16);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_locations_hafas_id" ON "locations" USING btree ("hafas_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_locations_label" ON "locations" USING btree ("label");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_locations_city" ON "locations" USING btree ("city");