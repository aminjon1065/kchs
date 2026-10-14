ALTER TABLE "layers" ALTER COLUMN "dataset_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "layers" ADD COLUMN "system_source" text;--> statement-breakpoint
ALTER TABLE "layers" ADD CONSTRAINT "layers_source_check" CHECK (("layers"."dataset_id" IS NULL) <> ("layers"."system_source" IS NULL));