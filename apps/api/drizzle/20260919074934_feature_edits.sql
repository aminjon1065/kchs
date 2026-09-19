CREATE TABLE "feature_edits" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "feature_edits_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"layer_id" uuid NOT NULL,
	"dataset_id" uuid NOT NULL,
	"row_id" bigint,
	"op" text NOT NULL,
	"values" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"geometry" jsonb,
	"base_ver" integer,
	"note" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"author_id" uuid,
	"reviewer_id" uuid,
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "feature_edits" ADD CONSTRAINT "feature_edits_layer_id_layers_id_fk" FOREIGN KEY ("layer_id") REFERENCES "public"."layers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_edits" ADD CONSTRAINT "feature_edits_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_edits" ADD CONSTRAINT "feature_edits_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "feature_edits_layer_idx" ON "feature_edits" USING btree ("layer_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "feature_edits_author_idx" ON "feature_edits" USING btree ("author_id","created_at" DESC NULLS LAST);