CREATE TABLE "agent_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"agent" text NOT NULL,
	"trigger" text NOT NULL,
	"dry_run" boolean DEFAULT false NOT NULL,
	"instruction" text,
	"status" text DEFAULT 'running' NOT NULL,
	"summary" text,
	"tool_calls" integer DEFAULT 0 NOT NULL,
	"proposed" integer DEFAULT 0 NOT NULL,
	"blocked" integer DEFAULT 0 NOT NULL,
	"errors" integer DEFAULT 0 NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" integer,
	"agent" text NOT NULL,
	"tool" text NOT NULL,
	"input" jsonb NOT NULL,
	"reason" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"result" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "clients" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"contact_name" text,
	"email" text,
	"phone" text,
	"website" text,
	"industry" text,
	"retainer_ex_vat" numeric(12, 2) DEFAULT 0 NOT NULL,
	"vat" text DEFAULT 'plus' NOT NULL,
	"billing_method" text DEFAULT 'invoice' NOT NULL,
	"start_date" date,
	"meta_ad_account_ids" text,
	"ghl_location_id" text,
	"stripe_customer_id" text,
	"cpl_target" numeric(12, 2),
	"report_currency" text DEFAULT 'EUR' NOT NULL,
	"report_greeting" text DEFAULT 'Hi guys' NOT NULL,
	"report_rules" text,
	"goals" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "health_checks" (
	"id" serial PRIMARY KEY NOT NULL,
	"client_id" integer NOT NULL,
	"week_of" date NOT NULL,
	"status" text NOT NULL,
	"cpl" numeric(12, 2),
	"leads" integer,
	"spend" numeric(12, 2),
	"issue" text,
	"reason" text,
	"action_needed" text,
	"resolved" boolean DEFAULT false NOT NULL,
	"source" text DEFAULT 'agent' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" serial PRIMARY KEY NOT NULL,
	"client_id" integer NOT NULL,
	"label" text DEFAULT 'Retainer' NOT NULL,
	"period" date NOT NULL,
	"amount_due" numeric(12, 2) NOT NULL,
	"amount_collected" numeric(12, 2) DEFAULT 0 NOT NULL,
	"due_date" date NOT NULL,
	"paid_date" date,
	"method" text,
	"stripe_invoice_id" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" serial PRIMARY KEY NOT NULL,
	"client_id" integer NOT NULL,
	"kind" text NOT NULL,
	"period" text NOT NULL,
	"body" text NOT NULL,
	"leads" integer,
	"spend" numeric(12, 2),
	"cpl" numeric(12, 2),
	"status" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" serial PRIMARY KEY NOT NULL,
	"client_id" integer,
	"title" text NOT NULL,
	"details" text,
	"status" text DEFAULT 'todo' NOT NULL,
	"priority" text DEFAULT 'medium' NOT NULL,
	"assignee" text,
	"due_date" date,
	"source" text DEFAULT 'human' NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "health_checks" ADD CONSTRAINT "health_checks_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approvals_status" ON "approvals" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "health_client_week" ON "health_checks" USING btree ("client_id","week_of");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_client_period_label" ON "payments" USING btree ("client_id","period","label");--> statement-breakpoint
CREATE INDEX "tasks_client" ON "tasks" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "tasks_status" ON "tasks" USING btree ("status");