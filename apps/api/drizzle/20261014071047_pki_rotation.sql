CREATE TABLE "pki_retired_authorities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"certificate" text NOT NULL,
	"key_enc" "bytea" NOT NULL,
	"fingerprint" text NOT NULL,
	"not_after" timestamp with time zone NOT NULL,
	"crl_number" integer DEFAULT 0 NOT NULL,
	"path" text NOT NULL,
	"reason" text NOT NULL,
	"retired_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"retired_by" uuid
);
--> statement-breakpoint
ALTER TABLE "pki_authorities" ADD COLUMN "path" text DEFAULT 'issuing' NOT NULL;--> statement-breakpoint
ALTER TABLE "pki_certificates" ADD COLUMN "issuer_fingerprint" text;--> statement-breakpoint
ALTER TABLE "pki_certificates" ADD COLUMN "replaced_by" uuid;--> statement-breakpoint
ALTER TABLE "pki_retired_authorities" ADD CONSTRAINT "pki_retired_authorities_retired_by_users_id_fk" FOREIGN KEY ("retired_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pki_retired_authorities_fingerprint_idx" ON "pki_retired_authorities" USING btree ("fingerprint");--> statement-breakpoint
CREATE UNIQUE INDEX "pki_retired_authorities_path_idx" ON "pki_retired_authorities" USING btree ("path") WHERE "pki_retired_authorities"."kind" = 'issuing';--> statement-breakpoint
-- Сертификаты, выпущенные до смены ключа, — от первого выпускающего (ADR-0224)
UPDATE "pki_certificates" SET "issuer_fingerprint" = (SELECT "fingerprint" FROM "pki_authorities" WHERE "kind" = 'issuing') WHERE "issuer_fingerprint" IS NULL;
