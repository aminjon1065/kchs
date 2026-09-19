CREATE TABLE "notebooks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"cells" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notebooks" ADD CONSTRAINT "notebooks_id_objects_id_fk" FOREIGN KEY ("id") REFERENCES "public"."objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "yjs"."documents" ADD CONSTRAINT "documents_object_id_objects_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."objects"("id") ON DELETE cascade ON UPDATE no action;