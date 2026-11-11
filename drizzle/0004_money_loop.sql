CREATE TABLE "cash_summaries" (
	"id" serial PRIMARY KEY NOT NULL,
	"as_of" date NOT NULL,
	"body" text NOT NULL,
	"data" jsonb NOT NULL,
	"posted_to_slack" boolean DEFAULT false NOT NULL,
	"run_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "incoming_payments" (
	"id" serial PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"received_date" date NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"allocated" numeric(12, 2) DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'EUR' NOT NULL,
	"payer" text,
	"reference" text,
	"description" text,
	"bank_format" text,
	"source_file" text,
	"stripe_customer_id" text,
	"stripe_invoice_id" text,
	"stripe_payment_intent_id" text,
	"client_id" integer,
	"status" text DEFAULT 'unmatched' NOT NULL,
	"matched_by" text,
	"allocations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"suggestions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "stripe_events" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"outcome" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cash_summaries" ADD CONSTRAINT "cash_summaries_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incoming_payments" ADD CONSTRAINT "incoming_payments_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "incoming_source_external" ON "incoming_payments" USING btree ("source","external_id");--> statement-breakpoint
CREATE INDEX "incoming_status" ON "incoming_payments" USING btree ("status");--> statement-breakpoint
CREATE INDEX "incoming_stripe_invoice" ON "incoming_payments" USING btree ("stripe_invoice_id");