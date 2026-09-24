ALTER TABLE "users" ADD COLUMN "kind" text DEFAULT 'person' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_kind_check" CHECK ("users"."kind" in ('person', 'service'));--> statement-breakpoint
-- ADR-0130: правило работает только от имени служебной учётной записи. Правила,
-- включённые от имени сотрудника, выключаются: включить их снова можно, выбрав
-- служебную запись в конструкторе (до этой миграции все учётные записи — сотрудники)
UPDATE "rules"
   SET "enabled" = false,
       "definition" = jsonb_set("definition", '{enabled}', 'false'::jsonb),
       "updated_at" = now()
 WHERE "enabled"
   AND ("run_as" IS NULL OR "run_as" NOT IN (SELECT "id" FROM "users" WHERE "kind" = 'service'));
