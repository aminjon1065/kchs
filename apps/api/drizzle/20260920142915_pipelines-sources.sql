CREATE TABLE "pipeline_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"pipeline_id" uuid NOT NULL,
	"job_id" uuid,
	"status" text DEFAULT 'queued' NOT NULL,
	"trigger" text DEFAULT 'manual' NOT NULL,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"rejected" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "pipelines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"definition" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"description" text,
	"schedule" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"run_on_import" boolean DEFAULT false NOT NULL,
	"input_dataset_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"output_dataset_id" uuid,
	"status" text DEFAULT 'draft' NOT NULL,
	"job_id" uuid,
	"row_count" bigint,
	"error" text,
	"last_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source_id" uuid NOT NULL,
	"job_id" uuid,
	"status" text DEFAULT 'queued' NOT NULL,
	"mode" text DEFAULT 'snapshot' NOT NULL,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text DEFAULT 'database' NOT NULL,
	"integration_id" uuid NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"description" text,
	"mode" text DEFAULT 'snapshot' NOT NULL,
	"cursor_value" text,
	"dataset_id" uuid,
	"schedule" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"status_message" text,
	"last_check_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"row_count" bigint,
	"job_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_layers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"url" text NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"description" text,
	"attribution" text,
	"min_zoom" integer DEFAULT 0 NOT NULL,
	"max_zoom" integer DEFAULT 19 NOT NULL,
	"opacity" real DEFAULT 1 NOT NULL,
	"tile_size" integer DEFAULT 256 NOT NULL,
	"status" text DEFAULT 'unknown' NOT NULL,
	"status_message" text,
	"last_check_at" timestamp with time zone,
	"secret_enc" "bytea",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD CONSTRAINT "pipeline_runs_pipeline_id_pipelines_id_fk" FOREIGN KEY ("pipeline_id") REFERENCES "public"."pipelines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD CONSTRAINT "pipeline_runs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipelines" ADD CONSTRAINT "pipelines_id_objects_id_fk" FOREIGN KEY ("id") REFERENCES "public"."objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipelines" ADD CONSTRAINT "pipelines_output_dataset_id_datasets_id_fk" FOREIGN KEY ("output_dataset_id") REFERENCES "public"."datasets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_runs" ADD CONSTRAINT "source_runs_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_runs" ADD CONSTRAINT "source_runs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_id_objects_id_fk" FOREIGN KEY ("id") REFERENCES "public"."objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_dataset_id_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."datasets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_layers" ADD CONSTRAINT "service_layers_id_objects_id_fk" FOREIGN KEY ("id") REFERENCES "public"."objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pipeline_runs_pipeline_idx" ON "pipeline_runs" USING btree ("pipeline_id","started_at");--> statement-breakpoint
CREATE INDEX "pipelines_output_idx" ON "pipelines" USING btree ("output_dataset_id");--> statement-breakpoint
CREATE INDEX "pipelines_inputs_idx" ON "pipelines" USING gin ("input_dataset_ids");--> statement-breakpoint
CREATE INDEX "pipelines_enabled_idx" ON "pipelines" USING btree ("enabled");--> statement-breakpoint
CREATE INDEX "source_runs_source_idx" ON "source_runs" USING btree ("source_id","started_at");--> statement-breakpoint
CREATE INDEX "sources_dataset_idx" ON "sources" USING btree ("dataset_id");--> statement-breakpoint
CREATE INDEX "sources_integration_idx" ON "sources" USING btree ("integration_id");--> statement-breakpoint
CREATE INDEX "sources_enabled_idx" ON "sources" USING btree ("enabled");--> statement-breakpoint
CREATE INDEX "service_layers_kind_idx" ON "service_layers" USING btree ("kind");