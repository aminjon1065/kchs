CREATE TABLE "report_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"report_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"run_as" uuid NOT NULL,
	"requested_by" uuid,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"formats" text[] DEFAULT '{pdf}'::text[] NOT NULL,
	"channels" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"job_id" uuid,
	"attempts" integer DEFAULT 0 NOT NULL,
	"files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"pages" integer,
	"duration_ms" integer,
	"error" text,
	"delivery" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"blocks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"schedule" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_report_id_objects_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_run_as_users_id_fk" FOREIGN KEY ("run_as") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_id_objects_id_fk" FOREIGN KEY ("id") REFERENCES "public"."objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "report_runs_report_idx" ON "report_runs" USING btree ("report_id","created_at");--> statement-breakpoint
CREATE INDEX "report_runs_run_as_idx" ON "report_runs" USING btree ("run_as","created_at");