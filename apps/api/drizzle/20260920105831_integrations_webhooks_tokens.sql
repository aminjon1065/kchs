CREATE TABLE "integration_syncs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"integration_id" uuid NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"message" text,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "integrations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"kind" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"description" text,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secrets" "bytea",
	"status" text DEFAULT 'unknown' NOT NULL,
	"status_message" text,
	"last_check_at" timestamp with time zone,
	"last_sync_at" timestamp with time zone,
	"inbound_enabled" boolean DEFAULT false NOT NULL,
	"inbound_secret_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integrations_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"webhook_id" uuid NOT NULL,
	"event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"response_status" integer,
	"error" text,
	"next_attempt_at" timestamp with time zone,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "webhooks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"url" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"event_types" text[] DEFAULT '{}'::text[] NOT NULL,
	"space_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"run_as_user_id" uuid NOT NULL,
	"secret" "bytea" NOT NULL,
	"failure_streak" integer DEFAULT 0 NOT NULL,
	"disable_after_failures" integer DEFAULT 20 NOT NULL,
	"last_delivery_at" timestamp with time zone,
	"last_status" integer,
	"last_error" text,
	"disabled_at" timestamp with time zone,
	"disabled_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhooks_key_unique" UNIQUE("key")
);
--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "prefix" text NOT NULL;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "created_by_id" uuid;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "last_used_ip" text;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "revoked_by_id" uuid;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "rate_limit_per_minute" integer;--> statement-breakpoint
ALTER TABLE "integration_syncs" ADD CONSTRAINT "integration_syncs_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_id_objects_id_fk" FOREIGN KEY ("id") REFERENCES "public"."objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_webhook_id_webhooks_id_fk" FOREIGN KEY ("webhook_id") REFERENCES "public"."webhooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_id_objects_id_fk" FOREIGN KEY ("id") REFERENCES "public"."objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_run_as_user_id_users_id_fk" FOREIGN KEY ("run_as_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "integration_syncs_integration_idx" ON "integration_syncs" USING btree ("integration_id","started_at");--> statement-breakpoint
CREATE INDEX "integrations_kind_idx" ON "integrations" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_hook_idx" ON "webhook_deliveries" USING btree ("webhook_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_deliveries_event_key" ON "webhook_deliveries" USING btree ("webhook_id","event_id");--> statement-breakpoint
CREATE INDEX "webhooks_status_idx" ON "webhooks" USING btree ("status");--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_revoked_by_id_users_id_fk" FOREIGN KEY ("revoked_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_prefix_unique" UNIQUE("prefix");