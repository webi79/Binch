CREATE TABLE IF NOT EXISTS "price_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"push_token_id" uuid NOT NULL,
	"user_id" uuid,
	"mode" varchar(8) NOT NULL,
	"origin" varchar(64) NOT NULL,
	"destination" varchar(64) NOT NULL,
	"origin_label" varchar(160) NOT NULL,
	"dest_label" varchar(160) NOT NULL,
	"depart_date" date NOT NULL,
	"currency" varchar(8) NOT NULL,
	"base_price" numeric(10, 2) NOT NULL,
	"desired_price" numeric(10, 2) NOT NULL,
	"notify_on_rise" boolean DEFAULT false NOT NULL,
	"last_seen_price" numeric(10, 2),
	"last_notified_at" timestamp with time zone,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "push_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token" varchar(255) NOT NULL,
	"user_id" uuid,
	"platform" varchar(16),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_tokens_token_unique" UNIQUE("token")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "price_alerts" ADD CONSTRAINT "price_alerts_push_token_id_push_tokens_id_fk" FOREIGN KEY ("push_token_id") REFERENCES "public"."push_tokens"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "price_alerts" ADD CONSTRAINT "price_alerts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "push_tokens" ADD CONSTRAINT "push_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_price_alerts_route" ON "price_alerts" USING btree ("active","mode","origin","destination","depart_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_price_alerts_token" ON "price_alerts" USING btree ("push_token_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_price_alerts_device_route" ON "price_alerts" USING btree ("push_token_id","mode","origin","destination","depart_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_push_tokens_user" ON "push_tokens" USING btree ("user_id");