ALTER TABLE "recordings" ADD COLUMN "pinned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "recordings" ADD COLUMN "pinned_by" uuid;--> statement-breakpoint
ALTER TABLE "recordings" ADD COLUMN "retention_warned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "recordings" ADD CONSTRAINT "recordings_pinned_by_users_id_fk" FOREIGN KEY ("pinned_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;