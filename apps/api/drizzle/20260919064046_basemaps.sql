CREATE TABLE "basemaps" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key" text,
	"kind" text NOT NULL,
	"url" text,
	"style" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attribution" text,
	"min_zoom" integer DEFAULT 0 NOT NULL,
	"max_zoom" integer DEFAULT 22 NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"secret_enc" "bytea",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "basemaps_key_unique" UNIQUE("key")
);
--> statement-breakpoint
ALTER TABLE "basemaps" ADD CONSTRAINT "basemaps_id_objects_id_fk" FOREIGN KEY ("id") REFERENCES "public"."objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "basemaps_default_idx" ON "basemaps" USING btree ("is_default") WHERE "basemaps"."is_default";