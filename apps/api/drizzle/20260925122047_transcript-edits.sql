ALTER TABLE "transcripts" ADD COLUMN "speakers" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "transcripts" ADD COLUMN "edited_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "transcripts" ADD COLUMN "edited_by" uuid;--> statement-breakpoint
ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_edited_by_users_id_fk" FOREIGN KEY ("edited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;