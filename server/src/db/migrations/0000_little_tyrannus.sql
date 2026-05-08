CREATE TABLE IF NOT EXISTS "locations" (
	"code" varchar(16) PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"city" text,
	"country" text,
	"type" varchar(16) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "provider_responses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"provider" varchar(64) NOT NULL,
	"mode" varchar(16) NOT NULL,
	"status_code" integer,
	"duration_ms" integer,
	"raw_response" jsonb,
	"result_count" integer DEFAULT 0 NOT NULL,
	"error" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mode" varchar(16) NOT NULL,
	"name" varchar(64) NOT NULL,
	"display_name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "providers_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "redirect_tokens" (
	"token" varchar(64) PRIMARY KEY NOT NULL,
	"result_id" uuid NOT NULL,
	"deep_link" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"click_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "search_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mode" varchar(16) NOT NULL,
	"origin" varchar(64) NOT NULL,
	"destination" varchar(64) NOT NULL,
	"origin_label" text,
	"dest_label" text,
	"depart_date" date NOT NULL,
	"return_date" date,
	"passengers" integer DEFAULT 1 NOT NULL,
	"currency" varchar(8) DEFAULT 'EUR' NOT NULL,
	"ip_hash" varchar(64),
	"user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "search_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"provider_response_id" uuid,
	"mode" varchar(16) NOT NULL,
	"provider" varchar(64) NOT NULL,
	"provider_logo" text,
	"origin" varchar(64) NOT NULL,
	"destination" varchar(64) NOT NULL,
	"origin_label" text,
	"dest_label" text,
	"depart_time" timestamp with time zone NOT NULL,
	"arrive_time" timestamp with time zone NOT NULL,
	"origin_tz" varchar(64),
	"destination_tz" varchar(64),
	"date_only" boolean DEFAULT false NOT NULL,
	"duration_minutes" integer NOT NULL,
	"stops" integer DEFAULT 0 NOT NULL,
	"stop_labels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"price" numeric(12, 2) NOT NULL,
	"currency" varchar(8) NOT NULL,
	"deep_link" text NOT NULL,
	"flight_number" varchar(16),
	"operated_by" text,
	"is_refundable" boolean,
	"baggage_included" boolean,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "provider_responses" ADD CONSTRAINT "provider_responses_request_id_search_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."search_requests"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "redirect_tokens" ADD CONSTRAINT "redirect_tokens_result_id_search_results_id_fk" FOREIGN KEY ("result_id") REFERENCES "public"."search_results"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "search_results" ADD CONSTRAINT "search_results_request_id_search_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."search_requests"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "search_results" ADD CONSTRAINT "search_results_provider_response_id_provider_responses_id_fk" FOREIGN KEY ("provider_response_id") REFERENCES "public"."provider_responses"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_locations_type" ON "locations" USING btree ("type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_provider_responses_request" ON "provider_responses" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_provider_responses_provider" ON "provider_responses" USING btree ("provider","fetched_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_redirect_tokens_expires" ON "redirect_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_search_requests_mode_created" ON "search_requests" USING btree ("mode","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_search_requests_origin_dest" ON "search_requests" USING btree ("origin","destination");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_search_results_request" ON "search_results" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_search_results_price" ON "search_results" USING btree ("price");