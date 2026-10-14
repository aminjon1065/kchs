CREATE TABLE "pki_authorities" (
	"kind" text PRIMARY KEY NOT NULL,
	"certificate" text NOT NULL,
	"key_enc" "bytea" NOT NULL,
	"fingerprint" text NOT NULL,
	"not_after" timestamp with time zone NOT NULL,
	"crl_number" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pki_certificates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"serial" text NOT NULL,
	"user_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"subject" text NOT NULL,
	"device_label" text NOT NULL,
	"certificate" text NOT NULL,
	"fingerprint" text NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revocation_reason" text,
	"revoked_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pki_certificates" ADD CONSTRAINT "pki_certificates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pki_certificates" ADD CONSTRAINT "pki_certificates_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pki_certificates_serial_idx" ON "pki_certificates" USING btree ("serial");--> statement-breakpoint
CREATE UNIQUE INDEX "pki_certificates_fingerprint_idx" ON "pki_certificates" USING btree ("fingerprint");--> statement-breakpoint
CREATE INDEX "pki_certificates_user_idx" ON "pki_certificates" USING btree ("user_id","issued_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "pki_certificates_revoked_idx" ON "pki_certificates" USING btree ("revoked_at") WHERE "pki_certificates"."revoked_at" IS NOT NULL;