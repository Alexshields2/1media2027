ALTER TABLE "agent_runs" ADD COLUMN "error" text;--> statement-breakpoint
CREATE INDEX "agent_runs_agent_started" ON "agent_runs" USING btree ("agent","started_at");--> statement-breakpoint
CREATE INDEX "agent_runs_status_started" ON "agent_runs" USING btree ("status","started_at");