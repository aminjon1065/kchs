CREATE TABLE "ops"."backups" (
	"id" uuid PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"key" text,
	"size_bytes" bigint,
	"requested_by" uuid,
	"error" text,
	"verified_at" timestamp with time zone,
	"verified_by" uuid,
	"verified_note" text
);
--> statement-breakpoint
CREATE INDEX "backups_started_idx" ON "ops"."backups" USING btree ("started_at");