CREATE TABLE "document_renders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"form_key" text,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"requested_by" uuid,
	"target" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"file_id" uuid,
	"pages" integer,
	"size" integer,
	"error" text,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"dedupe_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "document_renders_kind_check" CHECK ("document_renders"."kind" in ('print', 'fill', 'inspect', 'watermark')),
	CONSTRAINT "document_renders_status_check" CHECK ("document_renders"."status" in ('queued', 'running', 'ready', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "templates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text DEFAULT 'docx' NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"document_type_id" uuid,
	"file_id" uuid,
	"defaults" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"placeholders" text[] DEFAULT '{}'::text[] NOT NULL,
	"unknown_placeholders" text[] DEFAULT '{}'::text[] NOT NULL,
	"inspect_status" text DEFAULT 'none' NOT NULL,
	"inspect_error" text,
	"is_active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "templates_kind_check" CHECK ("templates"."kind" in ('docx'))
);
--> statement-breakpoint
ALTER TABLE "document_renders" ADD CONSTRAINT "document_renders_subject_id_objects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_renders" ADD CONSTRAINT "document_renders_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_renders" ADD CONSTRAINT "document_renders_file_id_objects_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."objects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_id_objects_id_fk" FOREIGN KEY ("id") REFERENCES "public"."objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_document_type_id_document_types_id_fk" FOREIGN KEY ("document_type_id") REFERENCES "public"."document_types"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_file_id_objects_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."objects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_renders_subject_idx" ON "document_renders" USING btree ("subject_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "document_renders_dedupe_uq" ON "document_renders" USING btree ("dedupe_key") WHERE "document_renders"."dedupe_key" is not null;--> statement-breakpoint
CREATE INDEX "templates_document_type_idx" ON "templates" USING btree ("document_type_id");