CREATE TABLE "dataset_columnar_copies" (
	"dataset_id" uuid PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'building' NOT NULL,
	"version" integer,
	"row_count" bigint,
	"size_bytes" bigint,
	"build_ms" integer,
	"key" text,
	"job_id" uuid,
	"error" text,
	"requested_at" timestamp with time zone,
	"built_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "dataset_columnar_copies" ADD CONSTRAINT "dataset_columnar_copies_dataset_id_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."datasets"("id") ON DELETE cascade ON UPDATE no action;