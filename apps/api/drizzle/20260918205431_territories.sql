CREATE TABLE "territories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"parent_id" uuid,
	"level" text NOT NULL,
	"name" jsonb NOT NULL,
	"geom" geometry(MultiPolygon, 4326),
	"centroid" geometry(Point, 4326),
	"area_km2" double precision,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dataset_row_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "territories_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "territory_closure" (
	"territory_id" uuid NOT NULL,
	"ancestor_id" uuid NOT NULL,
	"depth" integer NOT NULL,
	CONSTRAINT "territory_closure_territory_id_ancestor_id_pk" PRIMARY KEY("territory_id","ancestor_id")
);
--> statement-breakpoint
ALTER TABLE "territories" ADD CONSTRAINT "territories_id_objects_id_fk" FOREIGN KEY ("id") REFERENCES "public"."objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "territories" ADD CONSTRAINT "territories_parent_id_territories_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."territories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "territory_closure" ADD CONSTRAINT "territory_closure_territory_id_territories_id_fk" FOREIGN KEY ("territory_id") REFERENCES "public"."territories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "territory_closure" ADD CONSTRAINT "territory_closure_ancestor_id_territories_id_fk" FOREIGN KEY ("ancestor_id") REFERENCES "public"."territories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "territories_parent_idx" ON "territories" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "territories_level_idx" ON "territories" USING btree ("level");--> statement-breakpoint
CREATE INDEX "territories_geom_idx" ON "territories" USING gist ("geom");--> statement-breakpoint
CREATE INDEX "territory_closure_ancestor_idx" ON "territory_closure" USING btree ("ancestor_id");