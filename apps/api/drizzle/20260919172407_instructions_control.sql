CREATE TABLE "task_due_changes" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "task_due_changes_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"task_id" uuid NOT NULL,
	"from_due" timestamp with time zone,
	"to_due" timestamp with time zone,
	"working_days" smallint,
	"reason" text NOT NULL,
	"comment" text,
	"actor_id" uuid,
	"on_behalf_of" uuid,
	"extension_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_extensions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"from_due" timestamp with time zone,
	"requested_due" timestamp with time zone NOT NULL,
	"requested_working_days" smallint,
	"reason" text NOT NULL,
	"requested_by" uuid,
	"requested_on_behalf_of" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by" uuid,
	"decided_on_behalf_of" uuid,
	"decided_at" timestamp with time zone,
	"decision_comment" text,
	"approved_due" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "task_reminders" (
	"task_id" uuid NOT NULL,
	"stage" text NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"skipped" boolean DEFAULT false NOT NULL,
	CONSTRAINT "task_reminders_task_id_stage_due_at_pk" PRIMARY KEY("task_id","stage","due_at")
);
--> statement-breakpoint
ALTER TABLE "metrics" ADD COLUMN "system_source" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "due_working_days" smallint;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "original_due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "due_set_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "extensions" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "unit_id" uuid;--> statement-breakpoint
ALTER TABLE "task_due_changes" ADD CONSTRAINT "task_due_changes_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_due_changes" ADD CONSTRAINT "task_due_changes_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_extensions" ADD CONSTRAINT "task_extensions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_extensions" ADD CONSTRAINT "task_extensions_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_extensions" ADD CONSTRAINT "task_extensions_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_reminders" ADD CONSTRAINT "task_reminders_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_due_changes_task_idx" ON "task_due_changes" USING btree ("task_id","id");--> statement-breakpoint
CREATE INDEX "task_extensions_task_idx" ON "task_extensions" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "task_extensions_pending_uq" ON "task_extensions" USING btree ("task_id") WHERE "task_extensions"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "tasks_source_object_idx" ON "tasks" USING btree (("source"->>'objectId'));--> statement-breakpoint
CREATE INDEX "tasks_parent_idx" ON "tasks" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "tasks_unit_idx" ON "tasks" USING btree ("unit_id");--> statement-breakpoint
CREATE INDEX "tasks_due_open_idx" ON "tasks" USING btree ("due_at") WHERE "tasks"."kind" = 'instruction' and "tasks"."status" not in ('accepted', 'cancelled');--> statement-breakpoint
-- Поручения в полном режиме (ADR-0082): у существующих задач первоначальный срок —
-- действующий, момент установки срока — создание задачи
UPDATE "tasks" t SET "original_due_at" = t."due_at", "due_set_at" = o."created_at"
  FROM "objects" o WHERE o."id" = t."id";--> statement-breakpoint
-- Подразделение исполнителя — основное место работы
UPDATE "tasks" t SET "unit_id" = e."unit_id"
  FROM "employments" e
 WHERE e."user_id" = t."assignee_id" AND e."is_primary" AND e."ends_at" IS NULL;--> statement-breakpoint
-- История сроков начинается с назначенного срока
INSERT INTO "task_due_changes" ("task_id", "from_due", "to_due", "reason", "actor_id", "created_at")
SELECT t."id", NULL, t."due_at", 'set', t."author_id", o."created_at"
  FROM "tasks" t JOIN "objects" o ON o."id" = t."id"
 WHERE t."due_at" IS NOT NULL;--> statement-breakpoint
-- Системный датасет «Поручения»: состояние контроля исполнения вычисляется при
-- чтении («срок сегодня» — фильтром в поясе смотрящего), строки ограничивает
-- политика смотрящего по столбцу viewers. Исполнено в срок — по времени отчёта,
-- который принят: исполнитель не отвечает за то, когда автор принял отчёт
CREATE VIEW "ds"."sys_instructions" AS
SELECT
  i.id,
  i.key,
  i.title,
  i.status,
  i.priority,
  i.assignee,
  i.author,
  i.controller,
  i.unit,
  i.parent,
  i.is_part,
  i.source_kind,
  i.source,
  i.space,
  i.due_at,
  i.original_due_at,
  i.started_at,
  i.reported_at,
  i.completed_at,
  i.created_at,
  i.extensions,
  (i.extensions > 0) AS extended,
  s.state,
  (s.state = 'overdue') AS overdue,
  CASE WHEN s.state IN ('done_on_time', 'done_late') AND i.due_at IS NOT NULL
       THEN s.state = 'done_on_time' END AS on_time,
  CASE WHEN s.state IN ('done_on_time', 'done_late') AND i.due_at IS NOT NULL
       THEN CASE WHEN s.state = 'done_on_time' THEN 1 ELSE 0 END END AS on_time_score,
  CASE WHEN s.state IN ('overdue', 'done_late')
       THEN ceil(extract(epoch FROM (COALESCE(i.fact_at, now()) - i.due_at)) / 86400)::integer
  END AS days_late,
  i.viewers
FROM (
  SELECT
    t.id,
    t.key,
    o.title,
    t.status,
    t.priority::integer AS priority,
    t.assignee_id AS assignee,
    t.author_id AS author,
    t.controller_id AS controller,
    t.unit_id AS unit,
    t.parent_id AS parent,
    (t.parent_id IS NOT NULL) AS is_part,
    COALESCE(t.source->>'kind', 'none') AS source_kind,
    COALESCE(t.source->>'objectId', t.source->>'datasetId')::uuid AS source,
    o.space_id AS space,
    t.due_at,
    t.original_due_at,
    t.started_at,
    t.reported_at,
    t.completed_at,
    o.created_at,
    t.extensions::integer AS extensions,
    -- Когда исполнитель отчитался: отчёт ждёт приёмки или принят
    CASE WHEN t.status IN ('reported', 'accepted')
         THEN COALESCE(t.reported_at, t.completed_at) END AS fact_at,
    t.viewers
  FROM "public"."tasks" t
  JOIN "public"."objects" o ON o.id = t.id
  WHERE o.deleted_at IS NULL AND t.kind = 'instruction'
) i
CROSS JOIN LATERAL (
  SELECT CASE
    WHEN i.status = 'cancelled' THEN 'cancelled'
    WHEN i.status = 'accepted' THEN
      CASE WHEN i.due_at IS NULL OR i.fact_at <= i.due_at THEN 'done_on_time'
           ELSE 'done_late' END
    WHEN i.due_at IS NULL THEN 'open'
    WHEN COALESCE(i.fact_at, now()) > i.due_at THEN 'overdue'
    ELSE 'open'
  END AS state
) s;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kchs_query') THEN
    GRANT SELECT ON "ds"."sys_instructions" TO kchs_query;
  END IF;
END $$;