CREATE TABLE "warnings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"msg_type" text DEFAULT 'Alert' NOT NULL,
	"cap_status" text DEFAULT 'Actual' NOT NULL,
	"references_id" uuid,
	"superseded_by_id" uuid,
	"info" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"categories" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"urgency" text DEFAULT 'Expected' NOT NULL,
	"severity" text DEFAULT 'Moderate' NOT NULL,
	"certainty" text DEFAULT 'Likely' NOT NULL,
	"response_types" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"effective" timestamp with time zone,
	"expires" timestamp with time zone,
	"areas" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_dataset_id" uuid,
	"source_row_id" text,
	"signer_id" uuid,
	"author_id" uuid,
	"approved_at" timestamp with time zone,
	"approved_by_id" uuid,
	"published_at" timestamp with time zone,
	"cap_xml" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "warnings" ADD CONSTRAINT "warnings_id_objects_id_fk" FOREIGN KEY ("id") REFERENCES "public"."objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warnings" ADD CONSTRAINT "warnings_references_id_warnings_id_fk" FOREIGN KEY ("references_id") REFERENCES "public"."warnings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warnings" ADD CONSTRAINT "warnings_superseded_by_id_warnings_id_fk" FOREIGN KEY ("superseded_by_id") REFERENCES "public"."warnings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warnings" ADD CONSTRAINT "warnings_signer_id_users_id_fk" FOREIGN KEY ("signer_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warnings" ADD CONSTRAINT "warnings_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warnings" ADD CONSTRAINT "warnings_approved_by_id_users_id_fk" FOREIGN KEY ("approved_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "warnings_identifier_key" ON "warnings" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "warnings_status_idx" ON "warnings" USING btree ("status","published_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "warnings_references_idx" ON "warnings" USING btree ("references_id");--> statement-breakpoint
CREATE INDEX "warnings_source_idx" ON "warnings" USING btree ("source_dataset_id","source_row_id") WHERE "warnings"."source_dataset_id" IS NOT NULL;