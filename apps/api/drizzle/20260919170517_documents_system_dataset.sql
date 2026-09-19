-- Системный датасет «Документы» (08-documents.md §14, ADR-0080): представление
-- читает роль kchs_query; строки ограничивает политика смотрящего — пересечение
-- столбца viewers с его принципалами и гриф не выше допуска (grif_rank)
CREATE VIEW "ds"."sys_documents" AS
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
  d.viewers
FROM "public"."documents" d
JOIN "public"."objects" o ON o.id = d.id
JOIN "public"."document_types" t ON t.id = d.type_id
LEFT JOIN "public"."journals" j ON j.id = d.journal_id
LEFT JOIN "public"."correspondents" c ON c.id = d.correspondent_id
WHERE o.deleted_at IS NULL;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kchs_query') THEN
    GRANT SELECT ON "ds"."sys_documents" TO kchs_query;
  END IF;
END $$;
