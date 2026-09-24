ALTER TABLE "form_submissions" ADD COLUMN "rows" jsonb;--> statement-breakpoint
ALTER TABLE "form_submissions" ADD COLUMN "row_ids" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "forms" ADD COLUMN "responsible_users" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
-- Табличные формы (ADR-0129): строки сдачи — массивом; у сданных раньше
-- одиночных сводок массив из их единственной строки.
UPDATE public.form_submissions
   SET row_ids = ARRAY[row_id]
 WHERE row_id IS NOT NULL AND row_ids = '{}'::text[];
--> statement-breakpoint
-- Определения форм получают вид «одна запись», границы таблицы, сроки по
-- рабочим дням и пустого ответственного у каждого назначения — как их дописал
-- бы контракт.
UPDATE public.forms
   SET definition = jsonb_set(
         jsonb_set(
           definition
             || jsonb_build_object(
                  'layout', coalesce(definition -> 'layout', '"single"'::jsonb),
                  'table', coalesce(definition -> 'table', '{"minRows": 0, "maxRows": 200}'::jsonb)),
           '{schedule,dueMode}',
           coalesce(definition #> '{schedule,dueMode}', '"working"'::jsonb)),
         '{assignments}',
         coalesce(
           (SELECT jsonb_agg(item || jsonb_build_object(
                     'responsibleId', coalesce(item -> 'responsibleId', 'null'::jsonb)))
              FROM jsonb_array_elements(definition -> 'assignments') AS item),
           '[]'::jsonb))
 WHERE definition -> 'layout' IS NULL;
