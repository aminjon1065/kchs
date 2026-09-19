-- Ручная миграция (ADR-0077): население единицы справочника — в системном датасете
-- «Территории» для нормализации хороплетов («на 1 000 жителей»). Население хранится
-- в attributes.population (сид, ADR-0057); не число — пусто, а не ошибка запроса.
-- CREATE OR REPLACE VIEW добавляет столбец в конец и сохраняет права kchs_query
CREATE OR REPLACE VIEW "ds"."sys_territories" AS
SELECT
  t.id,
  t.code,
  t.level,
  t.parent_id,
  t.name->>'ru' AS name,
  t.name->>'tg' AS name_tg,
  t.name->>'en' AS name_en,
  t.geom,
  t.area_km2,
  CASE WHEN jsonb_typeof(t.attributes->'population') = 'number'
    THEN round((t.attributes->>'population')::numeric)::bigint
  END AS population
FROM "public"."territories" t
JOIN "public"."objects" o ON o.id = t.id
WHERE o.deleted_at IS NULL;
