CREATE TABLE "case_destruction_acts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"number" text NOT NULL,
	"year" integer NOT NULL,
	"sequence" integer NOT NULL,
	"act_date" date NOT NULL,
	"basis" text NOT NULL,
	"case_ids" uuid[] NOT NULL,
	"document_count" integer DEFAULT 0 NOT NULL,
	"file_count" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"index" text NOT NULL,
	"title" text NOT NULL,
	"year" integer NOT NULL,
	"unit_id" uuid,
	"retention_years" integer,
	"retention_note" text,
	"document_type_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"note" text,
	"closed_at" timestamp with time zone,
	"closed_by" uuid,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"destroyed_at" timestamp with time zone,
	"destruction_act_id" uuid,
	CONSTRAINT "cases_status_check" CHECK ("cases"."status" in ('open', 'closed', 'archived', 'destroyed'))
);
--> statement-breakpoint
CREATE TABLE "document_dispatches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"document_id" uuid NOT NULL,
	"correspondent_id" uuid,
	"addressee" text,
	"method" text NOT NULL,
	"sent_on" date NOT NULL,
	"tracking" text,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "filed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "filed_by" uuid;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "files_destroyed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "case_destruction_acts" ADD CONSTRAINT "case_destruction_acts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_id_objects_id_fk" FOREIGN KEY ("id") REFERENCES "public"."objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_unit_id_org_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."org_units"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_archived_by_users_id_fk" FOREIGN KEY ("archived_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_dispatches" ADD CONSTRAINT "document_dispatches_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_dispatches" ADD CONSTRAINT "document_dispatches_correspondent_id_correspondents_id_fk" FOREIGN KEY ("correspondent_id") REFERENCES "public"."correspondents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_dispatches" ADD CONSTRAINT "document_dispatches_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "case_destruction_acts_seq_uq" ON "case_destruction_acts" USING btree ("year","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "cases_year_index_uq" ON "cases" USING btree ("year",lower("index"));--> statement-breakpoint
CREATE INDEX "cases_unit_idx" ON "cases" USING btree ("unit_id","year");--> statement-breakpoint
CREATE INDEX "cases_status_idx" ON "cases" USING btree ("status","year");--> statement-breakpoint
CREATE INDEX "document_dispatches_document_idx" ON "document_dispatches" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "document_dispatches_sent_idx" ON "document_dispatches" USING btree ("sent_on");--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_filed_by_users_id_fk" FOREIGN KEY ("filed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "documents_case_idx" ON "documents" USING btree ("case_id");--> statement-breakpoint
-- Системный датасет «Документы» (ADR-0080) дополнен для канцелярии (ADR-0086):
-- закрытость, доля просрочки на контроле, дело, подшивка, архив, отправка.
-- Новые столбцы — в конце: CREATE OR REPLACE VIEW сохраняет прежние и права
CREATE OR REPLACE VIEW "ds"."sys_documents" AS
SELECT
  d.id,
  o.title AS subject,
  d.reg_number,
  d.reg_date,
  d.status,
  t.key AS type_key,
  t.name->>'ru' AS type_name,
  t.direction,
  d.journal_id AS journal,
  j.name AS journal_name,
  d.unit_id AS unit,
  d.author_id AS author,
  d.responsible_id AS responsible,
  d.signer_id AS signer,
  d.controller_id AS controller,
  d.correspondent_id AS correspondent,
  c.name AS correspondent_name,
  d.received_date,
  d.deadline,
  d.control,
  (d.control = 'on') AS on_control,
  (d.deadline IS NOT NULL AND d.deadline < current_date
    AND d.status NOT IN ('executed', 'filed', 'archived', 'cancelled')) AS overdue,
  d.executed_at,
  d.cancelled_at,
  o.created_at,
  d.confidentiality,
  CASE d.confidentiality
    WHEN 'public' THEN 0
    WHEN 'internal' THEN 1
    WHEN 'confidential' THEN 2
    ELSE 3
  END AS grif_rank,
  d.viewers,
  (d.status IN ('executed', 'filed', 'archived', 'cancelled')) AS closed,
  -- 100 — просрочен, 0 — в срок; только открытые документы на контроле:
  -- среднее — доля просроченных среди них (показатель канцелярии)
  CASE
    WHEN d.control = 'on' AND d.status NOT IN ('executed', 'filed', 'archived', 'cancelled')
      THEN CASE WHEN d.deadline IS NOT NULL AND d.deadline < current_date THEN 100 ELSE 0 END
  END AS overdue_score,
  d.case_id,
  cs.index AS case_index,
  cs.title AS case_title,
  d.filed_at,
  d.archived_at,
  (SELECT min(dd.sent_on) FROM "public"."document_dispatches" dd
    WHERE dd.document_id = d.id) AS sent_on
FROM "public"."documents" d
JOIN "public"."objects" o ON o.id = d.id
JOIN "public"."document_types" t ON t.id = d.type_id
LEFT JOIN "public"."journals" j ON j.id = d.journal_id
LEFT JOIN "public"."correspondents" c ON c.id = d.correspondent_id
LEFT JOIN "public"."cases" cs ON cs.id = d.case_id
WHERE o.deleted_at IS NULL;