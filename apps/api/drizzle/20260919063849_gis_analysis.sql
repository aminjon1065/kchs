CREATE TABLE "analyses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
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
ALTER TABLE "analyses" ADD CONSTRAINT "analyses_id_objects_id_fk" FOREIGN KEY ("id") REFERENCES "public"."objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analyses" ADD CONSTRAINT "analyses_output_dataset_id_datasets_id_fk" FOREIGN KEY ("output_dataset_id") REFERENCES "public"."datasets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "analyses_output_idx" ON "analyses" USING btree ("output_dataset_id");--> statement-breakpoint
CREATE INDEX "analyses_inputs_idx" ON "analyses" USING gin ("input_dataset_ids");--> statement-breakpoint
-- Ручной хвост (ADR-0069): системный датасет «Территории» — справочник с
-- границами для шага spatial (присвоение территории, цели-территории). Его читает
-- роль kchs_query; удалённые единицы не видны
CREATE VIEW "ds"."sys_territories" AS
SELECT
  t.id,
  t.code,
  t.level,
  t.parent_id,
  t.name->>'ru' AS name,
  t.name->>'tg' AS name_tg,
  t.name->>'en' AS name_en,
  t.geom,
  t.area_km2
FROM "public"."territories" t
JOIN "public"."objects" o ON o.id = t.id
WHERE o.deleted_at IS NULL;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kchs_query') THEN
    GRANT SELECT ON "ds"."sys_territories" TO kchs_query;
  END IF;
END $$;
