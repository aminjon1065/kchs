ALTER TABLE "rule_runs" ADD COLUMN "leased_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "rule_runs" ADD COLUMN "lease_owner" text;