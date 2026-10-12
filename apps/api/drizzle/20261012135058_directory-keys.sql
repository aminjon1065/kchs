-- Стабильные ключи журналов и шаблонов (ADR-0206, вопрос N42): расширение — столбец без
-- ограничения, заполнение по названию, затем NOT NULL и уникальность. Журналы стартового
-- набора (08-documents.md §5) получают свои ключи из кода, остальные — транслитерацию
-- названия (как keyFromName в контрактах); совпадения различаются хвостом из id.
-- Временной функции нет: у роли миграций нет права на временные объекты
ALTER TABLE "journals" ADD COLUMN "key" text;--> statement-breakpoint
ALTER TABLE "templates" ADD COLUMN "key" text;--> statement-breakpoint
WITH starter(name, key) AS (
  VALUES ('Входящие', 'incoming'), ('Исходящие', 'outgoing'), ('Внутренние', 'internal'),
         ('Приказы', 'orders'), ('Распоряжения', 'directives'), ('Договоры', 'contracts'),
         ('Обращения граждан', 'appeals')
),
slug AS (
  SELECT j.id, s.key AS starter_key,
    nullif(rtrim(left(trim(BOTH '_' FROM regexp_replace(
      translate(
        replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(
          replace(replace(replace(lower(j.name),
          'щ', 'shch'), 'ж', 'zh'), 'х', 'kh'), 'ц', 'ts'), 'ч', 'ch'), 'ш', 'sh'),
          'ю', 'yu'), 'я', 'ya'), 'ё', 'yo'), 'ғ', 'gh'), 'ъ', ''), 'ь', ''), 'ҷ', 'j'),
        'абвгдезийклмнопрстуфыэӣқӯҳ', 'abvgdeziyklmnoprstufyeiquh'),
      '[^a-z0-9]+', '_', 'g')), 60), '_'), '') AS k
  FROM "journals" j LEFT JOIN starter s ON s.name = j.name
),
base AS (
  SELECT id, coalesce(starter_key, CASE
    WHEN k IS NULL OR length(k) < 2 THEN 'journal'
    WHEN k ~ '^[0-9]' THEN left('j_' || k, 60)
    ELSE k
  END) AS key
  FROM slug
),
ranked AS (
  SELECT id, key, row_number() OVER (PARTITION BY key ORDER BY id) AS n FROM base
)
UPDATE "journals" j
SET "key" = CASE WHEN r.n = 1 THEN r.key ELSE r.key || '_' || substr(replace(j.id::text, '-', ''), 1, 6) END
FROM ranked r WHERE r.id = j.id;--> statement-breakpoint
WITH slug AS (
  SELECT t.id,
    nullif(rtrim(left(trim(BOTH '_' FROM regexp_replace(
      translate(
        replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(
          replace(replace(replace(lower(t.name),
          'щ', 'shch'), 'ж', 'zh'), 'х', 'kh'), 'ц', 'ts'), 'ч', 'ch'), 'ш', 'sh'),
          'ю', 'yu'), 'я', 'ya'), 'ё', 'yo'), 'ғ', 'gh'), 'ъ', ''), 'ь', ''), 'ҷ', 'j'),
        'абвгдезийклмнопрстуфыэӣқӯҳ', 'abvgdeziyklmnoprstufyeiquh'),
      '[^a-z0-9]+', '_', 'g')), 60), '_'), '') AS k
  FROM "templates" t
),
base AS (
  SELECT id, CASE
    WHEN k IS NULL OR length(k) < 2 THEN 'template'
    WHEN k ~ '^[0-9]' THEN left('j_' || k, 60)
    ELSE k
  END AS key
  FROM slug
),
ranked AS (
  SELECT id, key, row_number() OVER (PARTITION BY key ORDER BY id) AS n FROM base
)
UPDATE "templates" t
SET "key" = CASE WHEN r.n = 1 THEN r.key ELSE r.key || '_' || substr(replace(t.id::text, '-', ''), 1, 6) END
FROM ranked r WHERE r.id = t.id;--> statement-breakpoint
ALTER TABLE "journals" ALTER COLUMN "key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "templates" ALTER COLUMN "key" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "journals_key_uq" ON "journals" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX "templates_key_uq" ON "templates" USING btree ("key");
