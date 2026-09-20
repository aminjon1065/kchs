CREATE TABLE "auth_providers" (
	"kind" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secret_enc" "bytea",
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "directory_syncs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"mode" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"changes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"initiator_id" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sso_auth_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"state_hash" text NOT NULL,
	"nonce" text NOT NULL,
	"code_verifier_enc" "bytea" NOT NULL,
	"ip" text,
	"user_agent" text,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sso_auth_requests_state_hash_unique" UNIQUE("state_hash")
);
--> statement-breakpoint
CREATE TABLE "webauthn_challenges" (
	"id" uuid PRIMARY KEY NOT NULL,
	"purpose" text NOT NULL,
	"user_id" uuid,
	"challenge" text NOT NULL,
	"mfa_challenge_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webauthn_challenges_challenge_unique" UNIQUE("challenge")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "auth_source" text DEFAULT 'local' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "directory_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "directory_dn" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "directory_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "webauthn_credentials" ADD COLUMN "user_verified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "webauthn_credentials" ADD COLUMN "backed_up" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "webauthn_credentials" ADD COLUMN "aaguid" text;--> statement-breakpoint
ALTER TABLE "webauthn_challenges" ADD CONSTRAINT "webauthn_challenges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "directory_syncs_started_idx" ON "directory_syncs" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "sso_auth_requests_expires_idx" ON "sso_auth_requests" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "webauthn_challenges_expires_idx" ON "webauthn_challenges" USING btree ("expires_at");