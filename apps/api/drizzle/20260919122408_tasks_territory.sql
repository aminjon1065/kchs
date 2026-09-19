ALTER TABLE "tasks" ADD COLUMN "territory_id" uuid;--> statement-breakpoint
CREATE INDEX "tasks_territory_idx" ON "tasks" USING btree ("territory_id");