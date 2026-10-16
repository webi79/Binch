CREATE TABLE IF NOT EXISTS "imagery_usage" (
	"provider" varchar(32) NOT NULL,
	"month" varchar(7) NOT NULL,
	"tiles" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "imagery_usage_provider_month_pk" PRIMARY KEY("provider","month")
);
