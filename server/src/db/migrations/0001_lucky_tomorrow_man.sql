ALTER TABLE "redirect_tokens" ADD COLUMN "booking_token" text;--> statement-breakpoint
ALTER TABLE "redirect_tokens" ADD COLUMN "booking_context" jsonb;