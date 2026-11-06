CREATE TABLE IF NOT EXISTS "trip_reminders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"push_token_id" uuid NOT NULL,
	"key" varchar(160) NOT NULL,
	"kind" varchar(16) NOT NULL,
	"fire_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"title" varchar(120) NOT NULL,
	"body" varchar(300) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "trip_reminders" ADD CONSTRAINT "trip_reminders_push_token_id_push_tokens_id_fk" FOREIGN KEY ("push_token_id") REFERENCES "public"."push_tokens"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_trip_reminders_device_key" ON "trip_reminders" USING btree ("push_token_id","key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_trip_reminders_fire" ON "trip_reminders" USING btree ("fire_at");