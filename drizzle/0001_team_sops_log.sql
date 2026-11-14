CREATE TABLE "activity" (
	"id" serial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_type" text NOT NULL,
	"actor" text NOT NULL,
	"user_id" integer,
	"action" text NOT NULL,
	"summary" text NOT NULL,
	"entity" text,
	"entity_id" integer,
	"meta" jsonb
);
--> statement-breakpoint
CREATE TABLE "briefings" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"for_user_id" integer,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"run_id" integer,
	"voice_note_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eod_reports" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"date" date NOT NULL,
	"done" text NOT NULL,
	"blockers" text,
	"tomorrow" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sop_progress" (
	"id" serial PRIMARY KEY NOT NULL,
	"sop_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sops" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"category" text DEFAULT 'General' NOT NULL,
	"summary" text,
	"video_url" text,
	"body" text,
	"breakdown" text,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"file_name" text,
	"file_type" text,
	"file_data" text,
	"position" integer DEFAULT 0 NOT NULL,
	"owner_id" integer,
	"agent_enabled" boolean DEFAULT false NOT NULL,
	"schedule" text DEFAULT 'manual' NOT NULL,
	"weekday" integer,
	"month_day" integer,
	"per_client" boolean DEFAULT false NOT NULL,
	"autonomy" text DEFAULT 'L1' NOT NULL,
	"toolkits" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_run_date" date,
	"archived" boolean DEFAULT false NOT NULL,
	"created_by_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"title" text,
	"role" text DEFAULT 'member' NOT NULL,
	"manager_id" integer,
	"password_hash" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "voice_notes" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"transcript" text NOT NULL,
	"duration_sec" integer,
	"status" text DEFAULT 'processing' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "sop_id" integer;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "client_id" integer;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "started_by_id" integer;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "assignee_id" integer;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "created_by_id" integer;--> statement-breakpoint
ALTER TABLE "activity" ADD CONSTRAINT "activity_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "briefings" ADD CONSTRAINT "briefings_for_user_id_users_id_fk" FOREIGN KEY ("for_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "briefings" ADD CONSTRAINT "briefings_voice_note_id_voice_notes_id_fk" FOREIGN KEY ("voice_note_id") REFERENCES "public"."voice_notes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eod_reports" ADD CONSTRAINT "eod_reports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sop_progress" ADD CONSTRAINT "sop_progress_sop_id_sops_id_fk" FOREIGN KEY ("sop_id") REFERENCES "public"."sops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sop_progress" ADD CONSTRAINT "sop_progress_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sops" ADD CONSTRAINT "sops_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sops" ADD CONSTRAINT "sops_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_manager_id_users_id_fk" FOREIGN KEY ("manager_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_notes" ADD CONSTRAINT "voice_notes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_at" ON "activity" USING btree ("at");--> statement-breakpoint
CREATE INDEX "activity_actor" ON "activity" USING btree ("actor");--> statement-breakpoint
CREATE INDEX "briefings_for" ON "briefings" USING btree ("for_user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "eod_user_date" ON "eod_reports" USING btree ("user_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "sop_progress_user_sop" ON "sop_progress" USING btree ("user_id","sop_id");--> statement-breakpoint
CREATE INDEX "sops_category" ON "sops" USING btree ("category");--> statement-breakpoint
CREATE UNIQUE INDEX "users_name_lower" ON "users" USING btree (lower("name"));--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tasks_assignee" ON "tasks" USING btree ("assignee_id");--> statement-breakpoint
INSERT INTO "users" ("name", "role", "title") VALUES ('Alex', 'owner', 'Founder') ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "users" ("name", "role", "title", "manager_id") SELECT 'Jamie', 'manager', 'Operations', id FROM "users" WHERE lower(name) = 'alex' ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "users" ("name", "role", "title", "manager_id") SELECT 'Ryan', 'member', 'Delivery', id FROM "users" WHERE lower(name) = 'jamie' ON CONFLICT DO NOTHING;--> statement-breakpoint
UPDATE "tasks" t SET "assignee_id" = u.id FROM "users" u WHERE t."assignee_id" IS NULL AND t."assignee" IS NOT NULL AND lower(trim(t."assignee")) = lower(u.name);
