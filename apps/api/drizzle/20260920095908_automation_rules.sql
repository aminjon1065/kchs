CREATE TABLE "rule_dedupe" (
	"rule_id" uuid NOT NULL,
	"key" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rule_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"rule_id" uuid NOT NULL,
	"event_id" text,
	"event_type" text,
	"trigger_kind" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"object_id" uuid,
	"actor_id" uuid,
	"depth" integer DEFAULT 0 NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"resume_at" integer DEFAULT 0 NOT NULL,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"definition" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"run_as" uuid,
	"trigger_kind" text NOT NULL,
	"event_type" text,
	"cron" text,
	"timezone" text,
	"hook_key" text,
	"webhook_token" text,
	"last_run_at" timestamp with time zone,
	"last_status" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rules_key_unique" UNIQUE("key"),
	CONSTRAINT "rules_webhook_token_unique" UNIQUE("webhook_token")
);
--> statement-breakpoint
CREATE TABLE "schedules" (
	"key" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "rule_dedupe" ADD CONSTRAINT "rule_dedupe_rule_id_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule_runs" ADD CONSTRAINT "rule_runs_rule_id_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule_runs" ADD CONSTRAINT "rule_runs_object_id_objects_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."objects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule_runs" ADD CONSTRAINT "rule_runs_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_id_objects_id_fk" FOREIGN KEY ("id") REFERENCES "public"."objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_run_as_users_id_fk" FOREIGN KEY ("run_as") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "rule_dedupe_key" ON "rule_dedupe" USING btree ("rule_id","key");--> statement-breakpoint
CREATE INDEX "rule_dedupe_expires_idx" ON "rule_dedupe" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "rule_runs_rule_idx" ON "rule_runs" USING btree ("rule_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "rule_runs_created_idx" ON "rule_runs" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "rule_runs_cause_idx" ON "rule_runs" USING btree ("event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rule_runs_event_key" ON "rule_runs" USING btree ("rule_id","event_id") WHERE event_id is not null;--> statement-breakpoint
CREATE INDEX "rules_trigger_idx" ON "rules" USING btree ("trigger_kind","enabled");--> statement-breakpoint
CREATE INDEX "rules_event_idx" ON "rules" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX "rules_hook_idx" ON "rules" USING btree ("hook_key");