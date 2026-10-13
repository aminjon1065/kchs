CREATE TABLE "form_submission_photos" (
	"file_id" uuid PRIMARY KEY NOT NULL,
	"submission_id" uuid NOT NULL,
	"client_key" uuid NOT NULL,
	"field_key" text NOT NULL,
	"size" integer NOT NULL,
	"width" integer,
	"height" integer,
	"uploaded_by" uuid,
	"submitted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "form_submission_photos" ADD CONSTRAINT "form_submission_photos_file_id_objects_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_submission_photos" ADD CONSTRAINT "form_submission_photos_submission_id_form_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."form_submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_submission_photos" ADD CONSTRAINT "form_submission_photos_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "form_submission_photos_key_uq" ON "form_submission_photos" USING btree ("submission_id","client_key");