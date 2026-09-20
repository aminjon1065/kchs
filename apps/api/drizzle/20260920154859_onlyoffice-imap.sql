CREATE TABLE "mail_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"integration_id" uuid,
	"message_key" text NOT NULL,
	"uid" integer,
	"uid_validity" text,
	"from_email" text DEFAULT '' NOT NULL,
	"from_name" text,
	"to_email" text,
	"subject" text DEFAULT '' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sent_at" timestamp with time zone,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"document_id" uuid,
	"correspondent_id" uuid,
	"attachment_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"error" text,
	"reject_reason" text,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_messages_status_check" CHECK ("mail_messages"."status" in ('draft', 'registered', 'rejected', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "office_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"file_id" uuid NOT NULL,
	"version_id" uuid,
	"doc_key" text NOT NULL,
	"space_id" uuid,
	"opened_by" uuid,
	"status" text DEFAULT 'open' NOT NULL,
	"saved_version_id" uuid,
	"conflict" boolean DEFAULT false NOT NULL,
	"error" text,
	"last_callback_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "office_sessions_doc_key_unique" UNIQUE("doc_key")
);
--> statement-breakpoint
ALTER TABLE "mail_messages" ADD CONSTRAINT "mail_messages_document_id_objects_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."objects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_messages" ADD CONSTRAINT "mail_messages_correspondent_id_objects_id_fk" FOREIGN KEY ("correspondent_id") REFERENCES "public"."objects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_messages" ADD CONSTRAINT "mail_messages_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "office_sessions" ADD CONSTRAINT "office_sessions_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "office_sessions" ADD CONSTRAINT "office_sessions_opened_by_users_id_fk" FOREIGN KEY ("opened_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mail_messages_key_uq" ON "mail_messages" USING btree ("integration_id","message_key");--> statement-breakpoint
CREATE INDEX "mail_messages_status_idx" ON "mail_messages" USING btree ("status","received_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "mail_messages_document_idx" ON "mail_messages" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "office_sessions_file_idx" ON "office_sessions" USING btree ("file_id","status");