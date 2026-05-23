CREATE TABLE IF NOT EXISTS "cities" (
	"geoname_id" integer PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"ascii_name" text,
	"country" text,
	"latitude" numeric(9, 6) NOT NULL,
	"longitude" numeric(9, 6) NOT NULL,
	"population" integer
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_cities_name" ON "cities" USING btree ("name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_cities_country" ON "cities" USING btree ("country");