CREATE TABLE "document_emails" (
	"id" uuid PRIMARY KEY NOT NULL,
	"document_id" uuid NOT NULL,
	"correspondent_id" uuid,
	"to_address" text NOT NULL,
	"message" text,
	"with_attachments" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"message_id" text,
	"error" text,
	"dispatch_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "document_emails" ADD CONSTRAINT "document_emails_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_emails" ADD CONSTRAINT "document_emails_correspondent_id_correspondents_id_fk" FOREIGN KEY ("correspondent_id") REFERENCES "public"."correspondents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_emails" ADD CONSTRAINT "document_emails_dispatch_id_document_dispatches_id_fk" FOREIGN KEY ("dispatch_id") REFERENCES "public"."document_dispatches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_emails" ADD CONSTRAINT "document_emails_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_emails_document_idx" ON "document_emails" USING btree ("document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "document_emails_message_idx" ON "document_emails" USING btree ("message_id");