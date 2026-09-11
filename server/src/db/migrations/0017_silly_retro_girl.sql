ALTER TABLE "push_tokens" ADD COLUMN "last_delivered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "push_tokens" ADD COLUMN "last_tapped_at" timestamp with time zone;