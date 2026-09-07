ALTER TABLE "chat_conversations" ADD COLUMN "pinned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "chat_conversations" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_chat_conversations_user_pinned" ON "chat_conversations" USING btree ("user_id","pinned_at");