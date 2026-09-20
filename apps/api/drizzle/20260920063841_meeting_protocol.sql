CREATE TABLE "protocols" (
	"id" uuid PRIMARY KEY NOT NULL,
	"meeting_id" uuid NOT NULL,
	"status" text DEFAULT 'agenda' NOT NULL,
	"blocks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"summary" text,
	"instructions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"document_id" uuid,
	"confirmed_at" timestamp with time zone,
	"confirmed_by" uuid,
	"registered_at" timestamp with time zone,
	"acknowledgment_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "protocols" ADD CONSTRAINT "protocols_id_objects_id_fk" FOREIGN KEY ("id") REFERENCES "public"."objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "protocols" ADD CONSTRAINT "protocols_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "protocols" ADD CONSTRAINT "protocols_document_id_objects_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."objects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "protocols" ADD CONSTRAINT "protocols_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "protocols_meeting_idx" ON "protocols" USING btree ("meeting_id");--> statement-breakpoint
CREATE INDEX "protocols_document_idx" ON "protocols" USING btree ("document_id");