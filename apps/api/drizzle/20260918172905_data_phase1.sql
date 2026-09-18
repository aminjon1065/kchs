CREATE TABLE "charts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"query_id" uuid,
	"spec" jsonb NOT NULL,
	"params_defaults" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dataset_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dashboards" (
	"id" uuid PRIMARY KEY NOT NULL,
	"spec" jsonb NOT NULL,
	"refresh_interval" integer,
	"theme" text DEFAULT 'auto' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dataset_column_policies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"dataset_id" uuid NOT NULL,
	"principal_type" text NOT NULL,
	"principal_id" text NOT NULL,
	"mode" text NOT NULL,
	"fields" text[] NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dataset_fields" (
	"id" uuid PRIMARY KEY NOT NULL,
	"dataset_id" uuid NOT NULL,
	"key" text NOT NULL,
	"label" jsonb NOT NULL,
	"type" text NOT NULL,
	"semantic" text DEFAULT 'dimension' NOT NULL,
	"format" jsonb,
	"unit" text,
	"nullable" boolean DEFAULT true NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"unique" boolean DEFAULT false NOT NULL,
	"indexed" boolean DEFAULT false NOT NULL,
	"sensitive" boolean DEFAULT false NOT NULL,
	"lookup" jsonb,
	"formula" text,
	"description" text,
	"order" integer DEFAULT 0 NOT NULL,
	"definition" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"physical_column" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dataset_relations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"left_dataset_id" uuid NOT NULL,
	"left_field" text NOT NULL,
	"right_dataset_id" uuid NOT NULL,
	"right_field" text NOT NULL,
	"cardinality" text DEFAULT 'many_to_one' NOT NULL,
	"label" jsonb,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dataset_row_policies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"dataset_id" uuid NOT NULL,
	"principal_type" text NOT NULL,
	"principal_id" text NOT NULL,
	"filter" jsonb NOT NULL,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dataset_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"dataset_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"origin" text NOT NULL,
	"row_count" bigint DEFAULT 0 NOT NULL,
	"diff" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"import_id" uuid,
	"parquet_key" text,
	"schema_snapshot" jsonb,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "datasets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text DEFAULT 'table' NOT NULL,
	"storage" text DEFAULT 'postgres' NOT NULL,
	"source_id" uuid,
	"primary_key" text[] DEFAULT '{}'::text[] NOT NULL,
	"geometry" jsonb,
	"time_field" text,
	"territory_field" text,
	"row_count" bigint DEFAULT 0 NOT NULL,
	"current_version" integer DEFAULT 0 NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"description" text,
	"steward_id" uuid,
	"physical_table" text NOT NULL,
	"last_import_at" timestamp with time zone,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"next_column" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "imports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"dataset_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"mode" text DEFAULT 'replace' NOT NULL,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"mapping" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"key" text[] DEFAULT '{}'::text[] NOT NULL,
	"on_error" text DEFAULT 'skip' NOT NULL,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_sample" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"normalized_key" text,
	"errors_key" text,
	"errors_file_id" uuid,
	"job_id" uuid,
	"version" integer,
	"message" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "metrics" (
	"id" uuid PRIMARY KEY NOT NULL,
	"dataset_id" uuid,
	"definition" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"unit" text,
	"format" jsonb,
	"direction" text DEFAULT 'up' NOT NULL,
	"targets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"thresholds" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "queries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"mode" text DEFAULT 'visual' NOT NULL,
	"spec" jsonb NOT NULL,
	"sql" text,
	"params_schema" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dataset_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"compiled_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "query_runs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "query_runs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"query_id" uuid,
	"user_id" uuid,
	"spec_hash" text NOT NULL,
	"duration_ms" real NOT NULL,
	"row_count" bigint,
	"cached" boolean DEFAULT false NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "charts" ADD CONSTRAINT "charts_id_objects_id_fk" FOREIGN KEY ("id") REFERENCES "public"."objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charts" ADD CONSTRAINT "charts_query_id_queries_id_fk" FOREIGN KEY ("query_id") REFERENCES "public"."queries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboards" ADD CONSTRAINT "dashboards_id_objects_id_fk" FOREIGN KEY ("id") REFERENCES "public"."objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dataset_column_policies" ADD CONSTRAINT "dataset_column_policies_dataset_id_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."datasets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dataset_column_policies" ADD CONSTRAINT "dataset_column_policies_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dataset_fields" ADD CONSTRAINT "dataset_fields_dataset_id_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."datasets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dataset_relations" ADD CONSTRAINT "dataset_relations_left_dataset_id_datasets_id_fk" FOREIGN KEY ("left_dataset_id") REFERENCES "public"."datasets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dataset_relations" ADD CONSTRAINT "dataset_relations_right_dataset_id_datasets_id_fk" FOREIGN KEY ("right_dataset_id") REFERENCES "public"."datasets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dataset_relations" ADD CONSTRAINT "dataset_relations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dataset_row_policies" ADD CONSTRAINT "dataset_row_policies_dataset_id_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."datasets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dataset_row_policies" ADD CONSTRAINT "dataset_row_policies_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dataset_versions" ADD CONSTRAINT "dataset_versions_dataset_id_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."datasets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dataset_versions" ADD CONSTRAINT "dataset_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "datasets" ADD CONSTRAINT "datasets_id_objects_id_fk" FOREIGN KEY ("id") REFERENCES "public"."objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "datasets" ADD CONSTRAINT "datasets_steward_id_users_id_fk" FOREIGN KEY ("steward_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imports" ADD CONSTRAINT "imports_dataset_id_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."datasets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imports" ADD CONSTRAINT "imports_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metrics" ADD CONSTRAINT "metrics_id_objects_id_fk" FOREIGN KEY ("id") REFERENCES "public"."objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metrics" ADD CONSTRAINT "metrics_dataset_id_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."datasets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queries" ADD CONSTRAINT "queries_id_objects_id_fk" FOREIGN KEY ("id") REFERENCES "public"."objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dataset_column_policies_dataset_idx" ON "dataset_column_policies" USING btree ("dataset_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dataset_fields_key_uq" ON "dataset_fields" USING btree ("dataset_id","key");--> statement-breakpoint
CREATE INDEX "dataset_relations_left_idx" ON "dataset_relations" USING btree ("left_dataset_id");--> statement-breakpoint
CREATE INDEX "dataset_row_policies_dataset_idx" ON "dataset_row_policies" USING btree ("dataset_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dataset_versions_number_uq" ON "dataset_versions" USING btree ("dataset_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "datasets_physical_table_uq" ON "datasets" USING btree ("physical_table");--> statement-breakpoint
CREATE INDEX "imports_dataset_idx" ON "imports" USING btree ("dataset_id","created_at");--> statement-breakpoint
CREATE INDEX "query_runs_at_idx" ON "query_runs" USING btree ("created_at");