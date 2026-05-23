ALTER TABLE "cities" ADD COLUMN "feature_code" varchar(16);--> statement-breakpoint
ALTER TABLE "cities" ADD COLUMN "admin1" varchar(16);--> statement-breakpoint
ALTER TABLE "cities" ADD COLUMN "admin2" varchar(32);--> statement-breakpoint
ALTER TABLE "cities" ADD COLUMN "admin3" varchar(32);--> statement-breakpoint
ALTER TABLE "cities" ADD COLUMN "admin4" varchar(32);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_cities_admin" ON "cities" USING btree ("admin1","admin2","admin3","admin4");