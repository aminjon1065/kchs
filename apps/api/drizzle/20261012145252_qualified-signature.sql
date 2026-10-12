CREATE TABLE "document_qes_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"document_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"step_id" uuid NOT NULL,
	"signature_id" uuid NOT NULL,
	"signer_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"web_session_id" text,
	"state" text NOT NULL,
	"reason" text,
	"error" text,
	"certificate" jsonb,
	"certificate_der" text,
	"source" jsonb NOT NULL,
	"target" jsonb NOT NULL,
	"prepared" jsonb,
	"cms" text,
	"validation" jsonb,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "document_signatures" ADD COLUMN "certificate" jsonb;--> statement-breakpoint
ALTER TABLE "document_signatures" ADD COLUMN "validation" jsonb;--> statement-breakpoint
ALTER TABLE "document_signatures" ADD COLUMN "signed_file_id" uuid;--> statement-breakpoint
ALTER TABLE "document_qes_sessions" ADD CONSTRAINT "document_qes_sessions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_qes_sessions" ADD CONSTRAINT "document_qes_sessions_version_id_document_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."document_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_qes_sessions" ADD CONSTRAINT "document_qes_sessions_step_id_process_steps_id_fk" FOREIGN KEY ("step_id") REFERENCES "public"."process_steps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_qes_sessions" ADD CONSTRAINT "document_qes_sessions_signer_id_users_id_fk" FOREIGN KEY ("signer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_qes_sessions" ADD CONSTRAINT "document_qes_sessions_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "document_qes_sessions_signature_uq" ON "document_qes_sessions" USING btree ("signature_id");--> statement-breakpoint
CREATE INDEX "document_qes_sessions_version_idx" ON "document_qes_sessions" USING btree ("version_id","state");--> statement-breakpoint
CREATE INDEX "document_qes_sessions_document_idx" ON "document_qes_sessions" USING btree ("document_id");--> statement-breakpoint
ALTER TABLE "document_signatures" ADD CONSTRAINT "document_signatures_signed_file_id_objects_id_fk" FOREIGN KEY ("signed_file_id") REFERENCES "public"."objects"("id") ON DELETE set null ON UPDATE no action;