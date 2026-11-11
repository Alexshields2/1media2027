CREATE TABLE "report_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"period" text NOT NULL,
	"client_id" integer NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"last_error" text,
	"run_id" integer,
	"report_id" integer,
	"locked_until" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "drive_folder_id" text;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "period_start" date;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "period_end" date;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "impressions" integer;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "clicks" integer;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "ctr" numeric(7, 2);--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "run_id" integer;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "drive_file_id" text;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "drive_url" text;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "drive_error" text;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "report_jobs" ADD CONSTRAINT "report_jobs_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_jobs" ADD CONSTRAINT "report_jobs_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_jobs" ADD CONSTRAINT "report_jobs_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "report_jobs_kind_period_client" ON "report_jobs" USING btree ("kind","period","client_id");--> statement-breakpoint
CREATE INDEX "report_jobs_status" ON "report_jobs" USING btree ("status");--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reports_client_kind_period" ON "reports" USING btree ("client_id","kind","period");