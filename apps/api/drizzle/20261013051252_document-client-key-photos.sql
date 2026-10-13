CREATE TABLE "document_photos" (
	"file_id" uuid PRIMARY KEY NOT NULL,
	"document_id" uuid NOT NULL,
	"client_key" uuid NOT NULL,
	"size" integer NOT NULL,
	"width" integer,
	"height" integer,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "client_key" uuid;--> statement-breakpoint
ALTER TABLE "document_photos" ADD CONSTRAINT "document_photos_file_id_objects_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_photos" ADD CONSTRAINT "document_photos_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_photos" ADD CONSTRAINT "document_photos_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "document_photos_key_uq" ON "document_photos" USING btree ("document_id","client_key");--> statement-breakpoint
CREATE UNIQUE INDEX "documents_author_client_key_uq" ON "documents" USING btree ("author_id","client_key") WHERE "documents"."client_key" is not null;