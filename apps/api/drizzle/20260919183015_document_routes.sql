CREATE TABLE "document_signatures" (
	"id" uuid PRIMARY KEY NOT NULL,
	"document_id" uuid NOT NULL,
	"version_id" uuid,
	"step_id" uuid,
	"signer_id" uuid NOT NULL,
	"actor_id" uuid,
	"session_id" text,
	"hash" text,
	"kind" text DEFAULT 'simple' NOT NULL,
	"mfa" boolean DEFAULT false NOT NULL,
	"signed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_step_versions" (
	"step_id" uuid PRIMARY KEY NOT NULL,
	"document_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "document_signatures" ADD CONSTRAINT "document_signatures_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_signatures" ADD CONSTRAINT "document_signatures_version_id_document_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."document_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_signatures" ADD CONSTRAINT "document_signatures_step_id_process_steps_id_fk" FOREIGN KEY ("step_id") REFERENCES "public"."process_steps"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_signatures" ADD CONSTRAINT "document_signatures_signer_id_users_id_fk" FOREIGN KEY ("signer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_signatures" ADD CONSTRAINT "document_signatures_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_step_versions" ADD CONSTRAINT "document_step_versions_step_id_process_steps_id_fk" FOREIGN KEY ("step_id") REFERENCES "public"."process_steps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_step_versions" ADD CONSTRAINT "document_step_versions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_step_versions" ADD CONSTRAINT "document_step_versions_version_id_document_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."document_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_signatures_document_idx" ON "document_signatures" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "document_signatures_version_idx" ON "document_signatures" USING btree ("version_id");--> statement-breakpoint
CREATE INDEX "document_step_versions_document_idx" ON "document_step_versions" USING btree ("document_id");