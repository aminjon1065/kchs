CREATE TABLE "alert_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"alert_id" uuid NOT NULL,
	"metric_id" uuid NOT NULL,
	"fired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"group_key" text DEFAULT '' NOT NULL,
	"group_label" text DEFAULT '' NOT NULL,
	"group_values" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"value" double precision,
	"base" double precision,
	"score" double precision,
	"message" text NOT NULL,
	"channels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"metric_id" uuid NOT NULL,
	"definition" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"cron" text NOT NULL,
	"timezone" text NOT NULL,
	"condition_kind" text NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_fired_at" timestamp with time zone,
	"next_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "form_reminders" (
	"submission_id" uuid NOT NULL,
	"stage" text NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"skipped" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "form_submissions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"form_id" uuid NOT NULL,
	"period_key" text NOT NULL,
	"period_start" text NOT NULL,
	"period_end" text NOT NULL,
	"due_at" timestamp with time zone,
	"subject_kind" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"values" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"row_id" text,
	"author_id" uuid,
	"submitted_at" timestamp with time zone,
	"reviewer_id" uuid,
	"reviewed_at" timestamp with time zone,
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "forms" (
	"id" uuid PRIMARY KEY NOT NULL,
	"dataset_id" uuid NOT NULL,
	"definition" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"run_as" uuid,
	"periodicity" text DEFAULT 'monthly' NOT NULL,
	"assigned_units" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"assigned_users" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"reviewers" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "alert_events" ADD CONSTRAINT "alert_events_alert_id_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."alerts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_events" ADD CONSTRAINT "alert_events_metric_id_metrics_id_fk" FOREIGN KEY ("metric_id") REFERENCES "public"."metrics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_id_objects_id_fk" FOREIGN KEY ("id") REFERENCES "public"."objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_metric_id_metrics_id_fk" FOREIGN KEY ("metric_id") REFERENCES "public"."metrics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_reminders" ADD CONSTRAINT "form_reminders_submission_id_form_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."form_submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_form_id_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."forms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forms" ADD CONSTRAINT "forms_id_objects_id_fk" FOREIGN KEY ("id") REFERENCES "public"."objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forms" ADD CONSTRAINT "forms_dataset_id_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."datasets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forms" ADD CONSTRAINT "forms_run_as_users_id_fk" FOREIGN KEY ("run_as") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alert_events_alert_idx" ON "alert_events" USING btree ("alert_id","fired_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "alert_events_metric_idx" ON "alert_events" USING btree ("metric_id","fired_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "alert_events_cooldown_idx" ON "alert_events" USING btree ("alert_id","group_key","fired_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "alerts_metric_idx" ON "alerts" USING btree ("metric_id");--> statement-breakpoint
CREATE INDEX "alerts_due_idx" ON "alerts" USING btree ("enabled","next_run_at");--> statement-breakpoint
CREATE UNIQUE INDEX "form_reminders_uq" ON "form_reminders" USING btree ("submission_id","stage","due_at");--> statement-breakpoint
CREATE UNIQUE INDEX "form_submissions_period_uq" ON "form_submissions" USING btree ("form_id","period_key","subject_kind","subject_id");--> statement-breakpoint
CREATE INDEX "form_submissions_due_idx" ON "form_submissions" USING btree ("status","due_at");--> statement-breakpoint
CREATE INDEX "form_submissions_subject_idx" ON "form_submissions" USING btree ("subject_kind","subject_id","status");--> statement-breakpoint
CREATE INDEX "forms_dataset_idx" ON "forms" USING btree ("dataset_id");--> statement-breakpoint
CREATE INDEX "forms_enabled_idx" ON "forms" USING btree ("enabled");