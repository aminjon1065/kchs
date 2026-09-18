CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"lead_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"description" text,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"workflow" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"custom_fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"board_settings" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_counters" (
	"scope" text NOT NULL,
	"year" integer NOT NULL,
	"last_seq" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "task_counters_scope_year_pk" PRIMARY KEY("scope","year")
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text DEFAULT 'task' NOT NULL,
	"key" text NOT NULL,
	"project_id" uuid,
	"parent_id" uuid,
	"status" text NOT NULL,
	"priority" smallint DEFAULT 3 NOT NULL,
	"assignee_id" uuid,
	"co_assignees" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"author_id" uuid,
	"controller_id" uuid,
	"start_at" timestamp with time zone,
	"due_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"reported_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"requires_acceptance" boolean DEFAULT false NOT NULL,
	"description" text,
	"result" jsonb,
	"return_comment" text,
	"source" jsonb,
	"labels" text[] DEFAULT '{}'::text[] NOT NULL,
	"fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"order" double precision DEFAULT 0 NOT NULL,
	"viewers" text[] DEFAULT '{}'::text[] NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_id_objects_id_fk" FOREIGN KEY ("id") REFERENCES "public"."objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_lead_id_users_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_id_objects_id_fk" FOREIGN KEY ("id") REFERENCES "public"."objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_controller_id_users_id_fk" FOREIGN KEY ("controller_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "projects_key_uq" ON "projects" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_key_uq" ON "tasks" USING btree ("key");--> statement-breakpoint
CREATE INDEX "tasks_assignee_idx" ON "tasks" USING btree ("assignee_id","status","due_at");--> statement-breakpoint
CREATE INDEX "tasks_author_idx" ON "tasks" USING btree ("author_id","status");--> statement-breakpoint
CREATE INDEX "tasks_controller_idx" ON "tasks" USING btree ("controller_id");--> statement-breakpoint
CREATE INDEX "tasks_project_idx" ON "tasks" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "tasks_co_assignees_idx" ON "tasks" USING gin ("co_assignees");--> statement-breakpoint
CREATE INDEX "tasks_source_idx" ON "tasks" USING btree (("source"->>'datasetId'));--> statement-breakpoint
-- Системный датасет «Задачи» (ADR-0060): представление читает роль kchs_query,
-- строки ограничивает политика смотрящего по столбцу viewers
CREATE VIEW "ds"."sys_tasks" AS
SELECT
  t.id,
  t.key,
  o.title,
  t.kind,
  t.status,
  t.priority::integer AS priority,
  t.assignee_id AS assignee,
  t.author_id AS author,
  t.controller_id AS controller,
  t.project_id AS project,
  o.space_id AS space,
  t.due_at,
  t.started_at,
  t.reported_at,
  t.completed_at,
  o.created_at,
  (t.due_at IS NOT NULL AND t.due_at < now()
    AND t.status NOT IN ('done', 'accepted', 'cancelled')) AS overdue,
  CASE WHEN t.completed_at IS NULL OR t.due_at IS NULL THEN NULL
       ELSE t.completed_at <= t.due_at END AS on_time,
  t.viewers
FROM "public"."tasks" t
JOIN "public"."objects" o ON o.id = t.id
WHERE o.deleted_at IS NULL;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kchs_query') THEN
    GRANT SELECT ON "ds"."sys_tasks" TO kchs_query;
  END IF;
END $$;
