ALTER TABLE "clients" ADD COLUMN "notion_ids" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "notion_page_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "payments_notion_page" ON "payments" USING btree ("notion_page_id");