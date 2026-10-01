CREATE INDEX IF NOT EXISTS "idx_redirect_tokens_result" ON "redirect_tokens" USING btree ("result_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_search_results_provider_response" ON "search_results" USING btree ("provider_response_id");--> statement-breakpoint
ALTER TABLE "search_requests" DROP COLUMN IF EXISTS "ip_hash";