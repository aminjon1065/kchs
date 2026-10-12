CREATE TABLE "user_facsimiles" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"png" "bytea" NOT NULL,
	"sha256" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "document_signatures" ADD COLUMN "manifest" jsonb;--> statement-breakpoint
ALTER TABLE "document_signatures" ADD COLUMN "placement" jsonb;--> statement-breakpoint
ALTER TABLE "document_signatures" ADD COLUMN "facsimile" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "document_versions" ADD COLUMN "hashes" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "document_versions" ADD COLUMN "manifest_hash" text;--> statement-breakpoint
ALTER TABLE "document_versions" ADD COLUMN "signed_copy_file_id" uuid;--> statement-breakpoint
ALTER TABLE "user_facsimiles" ADD CONSTRAINT "user_facsimiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_facsimiles" ADD CONSTRAINT "user_facsimiles_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_signed_copy_file_id_objects_id_fk" FOREIGN KEY ("signed_copy_file_id") REFERENCES "public"."objects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- ADR-0198: прежние версии знают только хэш основного файла — он и остаётся в карте хэшей
UPDATE "document_versions"
   SET "hashes" = jsonb_build_object("main_file_id"::text, "hash")
 WHERE "hash" IS NOT NULL AND "main_file_id" IS NOT NULL;
