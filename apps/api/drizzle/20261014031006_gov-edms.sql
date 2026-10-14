CREATE TABLE "gov_edms_intakes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"document_id" uuid NOT NULL,
	"main_file_id" uuid,
	"file_name" text,
	"sha256" text,
	"prefill_status" text DEFAULT 'waiting' NOT NULL,
	"prefill" jsonb,
	"duplicate_of" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gov_edms_intakes_prefill_check" CHECK ("gov_edms_intakes"."prefill_status" in ('waiting', 'done', 'none'))
);
--> statement-breakpoint
ALTER TABLE "correspondents" ADD COLUMN "edms_exchange" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "gov_edms_intakes" ADD CONSTRAINT "gov_edms_intakes_document_id_objects_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gov_edms_intakes" ADD CONSTRAINT "gov_edms_intakes_main_file_id_objects_id_fk" FOREIGN KEY ("main_file_id") REFERENCES "public"."objects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gov_edms_intakes" ADD CONSTRAINT "gov_edms_intakes_duplicate_of_objects_id_fk" FOREIGN KEY ("duplicate_of") REFERENCES "public"."objects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gov_edms_intakes" ADD CONSTRAINT "gov_edms_intakes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "gov_edms_intakes_document_uq" ON "gov_edms_intakes" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "gov_edms_intakes_sha_idx" ON "gov_edms_intakes" USING btree ("sha256");--> statement-breakpoint
CREATE INDEX "gov_edms_intakes_file_idx" ON "gov_edms_intakes" USING btree ("main_file_id");--> statement-breakpoint
CREATE INDEX "gov_edms_intakes_created_idx" ON "gov_edms_intakes" USING btree ("created_at" DESC NULLS LAST);