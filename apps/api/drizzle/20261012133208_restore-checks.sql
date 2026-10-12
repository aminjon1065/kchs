CREATE TABLE "ops"."restore_checks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"ok" boolean NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	"backup_id" uuid,
	"recovered_to" timestamp with time zone,
	"host" text,
	"details" text DEFAULT '' NOT NULL,
	"reported_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "restore_checks_created_idx" ON "ops"."restore_checks" USING btree ("created_at");