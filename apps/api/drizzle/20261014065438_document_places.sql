-- Системный датасет «Документы на карте» (ADR-0223, N161): документы с точкой в реквизитах
-- карточки (поле-точка ADR-0221). Строки ограничивает политика смотрящего — та же, что у
-- ds.sys_documents: принципалы смотрящего пересекаются с viewers, гриф не строже допуска.
-- Точка и район — первые поля карточки типа с видом geometry и territory. _id — устойчивый
-- положительный номер строки из id документа (52 бита — точно и в JavaScript): им слой карты
-- различает объекты тайла.
CREATE VIEW "ds"."sys_document_places" AS
SELECT
  ('x' || substr(md5(d.id::text), 1, 13))::bit(52)::bigint AS _id,
  d.id,
  t.key AS type_key,
  t.name->>'ru' AS type_name,
  d.reg_number,
  d.reg_date,
  o.title AS subject,
  d.status,
  CASE
    WHEN (d.fields->>terr.key) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN (d.fields->>terr.key)::uuid
  END AS territory,
  ST_SetSRID(
    ST_MakePoint(
      (d.fields->place.key->'coordinates'->>0)::float8,
      (d.fields->place.key->'coordinates'->>1)::float8
    ),
    4326
  ) AS location,
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
CROSS JOIN LATERAL (
  SELECT f->>'key' AS key
  FROM jsonb_array_elements(COALESCE(t.card_schema->'fields', '[]'::jsonb)) f
  WHERE f->>'type' = 'geometry'
  LIMIT 1
) place
LEFT JOIN LATERAL (
  SELECT f->>'key' AS key
  FROM jsonb_array_elements(COALESCE(t.card_schema->'fields', '[]'::jsonb)) f
  WHERE f->>'type' = 'territory'
  LIMIT 1
) terr ON true
WHERE o.deleted_at IS NULL
  AND jsonb_typeof(d.fields->place.key) = 'object'
  AND d.fields->place.key->>'type' = 'Point'
  AND jsonb_typeof(d.fields->place.key->'coordinates'->0) = 'number'
  AND jsonb_typeof(d.fields->place.key->'coordinates'->1) = 'number';
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kchs_query') THEN
    GRANT SELECT ON "ds"."sys_document_places" TO kchs_query;
  END IF;
END $$;
