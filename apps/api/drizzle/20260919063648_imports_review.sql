ALTER TABLE "imports" ADD COLUMN "review" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "imports" ADD COLUMN "diff" jsonb;