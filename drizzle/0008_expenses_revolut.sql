CREATE TABLE "expense_merchant_rules" (
	"merchant_key" text PRIMARY KEY NOT NULL,
	"category" text NOT NULL,
	"updated_by" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "expenses" (
	"id" serial PRIMARY KEY NOT NULL,
	"date" date NOT NULL,
	"merchant" text NOT NULL,
	"merchant_key" text NOT NULL,
	"description" text,
	"amount" numeric(12, 2) NOT NULL,
	"currency" text DEFAULT 'EUR' NOT NULL,
	"amount_eur" numeric(12, 2),
	"category" text,
	"category_source" text,
	"vat_amount" numeric(12, 2),
	"client_id" integer,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"revolut_account_id" text,
	"card_last4" text,
	"receipt_url" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "revolut_connection" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"certificate_pem" text,
	"client_id" text,
	"redirect_uri" text,
	"oauth_state" text,
	"connected_at" timestamp with time zone,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"needs_reauth_at" timestamp with time zone,
	"accounts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"synced_through" timestamp with time zone,
	"last_sync_at" timestamp with time zone,
	"last_sync_result" jsonb,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "secrets" (
	"name" text PRIMARY KEY NOT NULL,
	"ciphertext" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "expense_merchant_rules" ADD CONSTRAINT "expense_merchant_rules_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "expenses_source_external" ON "expenses" USING btree ("source","external_id");--> statement-breakpoint
CREATE INDEX "expenses_external" ON "expenses" USING btree ("external_id");--> statement-breakpoint
CREATE INDEX "expenses_date" ON "expenses" USING btree ("date");--> statement-breakpoint
CREATE INDEX "expenses_merchant_key" ON "expenses" USING btree ("merchant_key");--> statement-breakpoint
-- Data (additive only): let the existing Jarvis and Payments chat agents read expenses. Skips agents that already have the tool.
UPDATE "agent_profiles" SET "os_tools" = "os_tools" || '["OS_LIST_EXPENSES"]'::jsonb WHERE "slug" IN ('jarvis', 'payments') AND NOT ("os_tools" @> '["OS_LIST_EXPENSES"]'::jsonb);
