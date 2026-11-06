CREATE TABLE IF NOT EXISTS "bo_task_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"ran_at" timestamp with time zone DEFAULT now() NOT NULL,
	"trigger" varchar(8) NOT NULL,
	"status" varchar(8) NOT NULL,
	"title" varchar(120) NOT NULL,
	"body" varchar(600) NOT NULL,
	"facts" jsonb,
	"pushed" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bo_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"conversation_id" uuid,
	"kind" varchar(24) NOT NULL,
	"title" varchar(60) NOT NULL,
	"origin" varchar(64) NOT NULL,
	"destination" varchar(64) NOT NULL,
	"origin_label" varchar(160) NOT NULL,
	"dest_label" varchar(160) NOT NULL,
	"days" integer NOT NULL,
	"time" varchar(5) NOT NULL,
	"watch_until" varchar(5),
	"timezone" varchar(64) NOT NULL,
	"notify" varchar(8) NOT NULL,
	"locale" varchar(5) DEFAULT 'de' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"next_run_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"last_status" varchar(8),
	"last_summary" varchar(300),
	"last_issue_key" varchar(400),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "push_tokens" ADD COLUMN "bo_updates_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bo_task_runs" ADD CONSTRAINT "bo_task_runs_task_id_bo_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."bo_tasks"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bo_tasks" ADD CONSTRAINT "bo_tasks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bo_tasks" ADD CONSTRAINT "bo_tasks_conversation_id_chat_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."chat_conversations"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_bo_task_runs_task" ON "bo_task_runs" USING btree ("task_id","ran_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_bo_tasks_user" ON "bo_tasks" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_bo_tasks_due" ON "bo_tasks" USING btree ("next_run_at");