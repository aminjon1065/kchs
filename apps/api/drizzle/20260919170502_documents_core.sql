CREATE TABLE "correspondents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text DEFAULT 'organization' NOT NULL,
	"name" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"contacts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"external_id" text
);
--> statement-breakpoint
CREATE TABLE "document_participants" (
	"document_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"source" text DEFAULT 'card' NOT NULL,
	"level" smallint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_participants_document_id_user_id_role_source_pk" PRIMARY KEY("document_id","user_id","role","source")
);
--> statement-breakpoint
CREATE TABLE "document_types" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"name" jsonb NOT NULL,
	"direction" text NOT NULL,
	"card_schema" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"numbering" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"default_route_key" text,
	"retention_years" integer,
	"confidentiality_allowed" text[] DEFAULT '{public,internal,confidential}'::text[] NOT NULL,
	"default_confidentiality" text DEFAULT 'internal' NOT NULL,
	"print_forms" text[] DEFAULT '{}'::text[] NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"document_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"main_file_id" uuid,
	"pdf_file_id" uuid,
	"pdf_status" text DEFAULT 'none' NOT NULL,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"note" text,
	"hash" text,
	"is_final" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"type_id" uuid NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"reg_number" text,
	"reg_date" date,
	"journal_id" uuid,
	"subject" text DEFAULT '' NOT NULL,
	"summary" text,
	"correspondent_id" uuid,
	"external_number" text,
	"external_date" date,
	"received_date" date,
	"delivery_method" text,
	"author_id" uuid,
	"responsible_id" uuid,
	"signer_id" uuid,
	"deadline" date,
	"control" text DEFAULT 'none' NOT NULL,
	"controller_id" uuid,
	"confidentiality" text DEFAULT 'internal' NOT NULL,
	"fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"current_version_id" uuid,
	"case_id" uuid,
	"territory_id" uuid,
	"unit_id" uuid,
	"executed_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"viewers" text[] DEFAULT '{}'::text[] NOT NULL,
	CONSTRAINT "documents_confidentiality_check" CHECK ("documents"."confidentiality" in ('public', 'internal', 'confidential', 'secret')),
	CONSTRAINT "documents_control_check" CHECK ("documents"."control" in ('none', 'on', 'done'))
);
--> statement-breakpoint
CREATE TABLE "journal_counters" (
	"journal_id" uuid NOT NULL,
	"year" integer NOT NULL,
	"last_seq" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "journal_counters_journal_id_year_pk" PRIMARY KEY("journal_id","year")
);
--> statement-breakpoint
CREATE TABLE "journal_reservations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"journal_id" uuid NOT NULL,
	"year" integer NOT NULL,
	"sequence" integer NOT NULL,
	"number" text NOT NULL,
	"note" text NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"reserved_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"document_id" uuid,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "journals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"prefix" text DEFAULT '' NOT NULL,
	"format" text NOT NULL,
	"reset" text DEFAULT 'year' NOT NULL,
	"unit_id" uuid,
	"type_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "registrations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"document_id" uuid NOT NULL,
	"journal_id" uuid NOT NULL,
	"number" text NOT NULL,
	"sequence" integer NOT NULL,
	"year" integer NOT NULL,
	"reserved" boolean DEFAULT false NOT NULL,
	"registered_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "admin_mode_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "admin_mode_reason" text;--> statement-breakpoint
ALTER TABLE "objects" ADD COLUMN "confidentiality" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "correspondents" ADD CONSTRAINT "correspondents_id_objects_id_fk" FOREIGN KEY ("id") REFERENCES "public"."objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_participants" ADD CONSTRAINT "document_participants_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_participants" ADD CONSTRAINT "document_participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_types" ADD CONSTRAINT "document_types_id_objects_id_fk" FOREIGN KEY ("id") REFERENCES "public"."objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_main_file_id_objects_id_fk" FOREIGN KEY ("main_file_id") REFERENCES "public"."objects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_pdf_file_id_objects_id_fk" FOREIGN KEY ("pdf_file_id") REFERENCES "public"."objects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_id_objects_id_fk" FOREIGN KEY ("id") REFERENCES "public"."objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_type_id_document_types_id_fk" FOREIGN KEY ("type_id") REFERENCES "public"."document_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_journal_id_journals_id_fk" FOREIGN KEY ("journal_id") REFERENCES "public"."journals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_correspondent_id_correspondents_id_fk" FOREIGN KEY ("correspondent_id") REFERENCES "public"."correspondents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_responsible_id_users_id_fk" FOREIGN KEY ("responsible_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_signer_id_users_id_fk" FOREIGN KEY ("signer_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_controller_id_users_id_fk" FOREIGN KEY ("controller_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_unit_id_org_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."org_units"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_counters" ADD CONSTRAINT "journal_counters_journal_id_journals_id_fk" FOREIGN KEY ("journal_id") REFERENCES "public"."journals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_reservations" ADD CONSTRAINT "journal_reservations_journal_id_journals_id_fk" FOREIGN KEY ("journal_id") REFERENCES "public"."journals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_reservations" ADD CONSTRAINT "journal_reservations_reserved_by_users_id_fk" FOREIGN KEY ("reserved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journals" ADD CONSTRAINT "journals_id_objects_id_fk" FOREIGN KEY ("id") REFERENCES "public"."objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journals" ADD CONSTRAINT "journals_unit_id_org_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."org_units"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registrations" ADD CONSTRAINT "registrations_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registrations" ADD CONSTRAINT "registrations_journal_id_journals_id_fk" FOREIGN KEY ("journal_id") REFERENCES "public"."journals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registrations" ADD CONSTRAINT "registrations_registered_by_users_id_fk" FOREIGN KEY ("registered_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "correspondents_name_trgm" ON "correspondents" USING gin ("name" extensions.gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "correspondents_external_uq" ON "correspondents" USING btree ("external_id") WHERE "correspondents"."external_id" is not null;--> statement-breakpoint
CREATE INDEX "document_participants_user_idx" ON "document_participants" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "document_types_key_uq" ON "document_types" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX "document_versions_number_uq" ON "document_versions" USING btree ("document_id","number");--> statement-breakpoint
CREATE INDEX "documents_type_status_idx" ON "documents" USING btree ("type_id","status");--> statement-breakpoint
CREATE INDEX "documents_reg_number_idx" ON "documents" USING btree ("reg_number");--> statement-breakpoint
CREATE INDEX "documents_journal_idx" ON "documents" USING btree ("journal_id","reg_date" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "documents_responsible_idx" ON "documents" USING btree ("responsible_id","deadline");--> statement-breakpoint
CREATE INDEX "documents_controller_idx" ON "documents" USING btree ("controller_id");--> statement-breakpoint
CREATE INDEX "documents_correspondent_idx" ON "documents" USING btree ("correspondent_id");--> statement-breakpoint
CREATE INDEX "documents_fields_idx" ON "documents" USING gin ("fields");--> statement-breakpoint
CREATE UNIQUE INDEX "journal_reservations_seq_uq" ON "journal_reservations" USING btree ("journal_id","year","sequence");--> statement-breakpoint
CREATE INDEX "journal_reservations_open_idx" ON "journal_reservations" USING btree ("journal_id","state");--> statement-breakpoint
CREATE INDEX "journals_unit_idx" ON "journals" USING btree ("unit_id");--> statement-breakpoint
CREATE UNIQUE INDEX "registrations_seq_uq" ON "registrations" USING btree ("journal_id","year","sequence");--> statement-breakpoint
CREATE INDEX "registrations_document_idx" ON "registrations" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "objects_confidential_idx" ON "objects" USING btree ("confidentiality") WHERE "objects"."confidentiality" <> 'public';--> statement-breakpoint
ALTER TABLE "objects" ADD CONSTRAINT "objects_confidentiality_check" CHECK ("objects"."confidentiality" in ('public', 'internal', 'confidential', 'secret'));