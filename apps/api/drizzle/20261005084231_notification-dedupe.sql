ALTER TABLE "notifications" ADD COLUMN "dedupe_key" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "external_sent_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_dedupe_idx" ON "notifications" USING btree ("user_id","dedupe_key") WHERE "notifications"."dedupe_key" is not null;