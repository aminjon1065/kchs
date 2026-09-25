CREATE TABLE "task_series" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text DEFAULT 'instruction' NOT NULL,
	"template" jsonb NOT NULL,
	"rule" jsonb NOT NULL,
	"due_working_days" smallint DEFAULT 1 NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date,
	"max_count" integer,
	"status" text DEFAULT 'active' NOT NULL,
	"status_reason" text,
	"created_count" integer DEFAULT 0 NOT NULL,
	"last_occurrence" date,
	"next_run_at" timestamp with time zone,
	"author_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "series_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "occurrence" date;--> statement-breakpoint
ALTER TABLE "task_series" ADD CONSTRAINT "task_series_id_objects_id_fk" FOREIGN KEY ("id") REFERENCES "public"."objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_series" ADD CONSTRAINT "task_series_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_series_due_idx" ON "task_series" USING btree ("next_run_at") WHERE "task_series"."status" = 'active';--> statement-breakpoint
CREATE INDEX "task_series_author_idx" ON "task_series" USING btree ("author_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_series_occurrence_uq" ON "tasks" USING btree ("series_id","occurrence") WHERE "tasks"."series_id" is not null;