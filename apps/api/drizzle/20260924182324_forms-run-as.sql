-- ADR-0130: форма пишет строки только от имени служебной учётной записи. У форм,
-- заведённых от имени сотрудника (до ADR-0130 форма работала от имени создателя),
-- запись снимается, включённые выключаются: включить снова можно, выбрав служебную
-- запись в настройках формы.
UPDATE "objects"
   SET "meta" = "meta" || '{"enabled": false}'::jsonb
 WHERE "id" IN (
   SELECT "id" FROM "forms"
    WHERE "enabled"
      AND ("run_as" IS NULL OR "run_as" NOT IN (SELECT "id" FROM "users" WHERE "kind" = 'service')));
--> statement-breakpoint
UPDATE "forms"
   SET "run_as" = NULL,
       "enabled" = false,
       "updated_at" = now()
 WHERE "run_as" IS NULL OR "run_as" NOT IN (SELECT "id" FROM "users" WHERE "kind" = 'service');
