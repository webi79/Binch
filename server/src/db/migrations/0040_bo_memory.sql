-- Bos Gedächtnis je Konto (Stand 28.10.2026).
--
-- `bo_memories`: kurze Sätze, die Bo über sein Werkzeug `remember` schreibt
-- („Heimatbahnhof Werl", „BahnCard 50"). Jeder Turn bekommt sie in den
-- ungecachten Teil seiner Anweisungen. Löschen mit dem Konto (cascade), einzeln
-- und komplett über Einstellungen → Bo.
--
-- `users.bo_memory_enabled`: der Schalter dazu. Vorgabe an — das Gedächtnis
-- ist gewünscht; aus heißt, Bo liest und schreibt es nicht.
CREATE TABLE IF NOT EXISTS "bo_memories" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "bo_memories_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" uuid NOT NULL,
	"content" varchar(300) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "bo_memory_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bo_memories" ADD CONSTRAINT "bo_memories_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_bo_memories_user" ON "bo_memories" USING btree ("user_id","updated_at");