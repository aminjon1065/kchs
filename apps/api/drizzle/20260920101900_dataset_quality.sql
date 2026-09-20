CREATE TABLE "dataset_quality_rules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"dataset_id" uuid NOT NULL,
	"key" text NOT NULL,
	"kind" text NOT NULL,
	"field" text,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"severity" text DEFAULT 'error' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dataset_quality_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"dataset_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" text NOT NULL,
	"results" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "dataset_quality_rules" ADD CONSTRAINT "dataset_quality_rules_dataset_id_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."datasets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dataset_quality_runs" ADD CONSTRAINT "dataset_quality_runs_dataset_id_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."datasets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dataset_quality_rules_key_uq" ON "dataset_quality_rules" USING btree ("dataset_id","key");--> statement-breakpoint
CREATE INDEX "dataset_quality_runs_idx" ON "dataset_quality_runs" USING btree ("dataset_id","created_at");