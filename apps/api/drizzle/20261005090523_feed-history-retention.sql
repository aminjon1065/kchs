-- Срок хранения истории строк датасетов лент — 90 дней (ADR-0173): лента правит строки
-- без конца, и история росла без предела. Датасетам, где срок уже задан, не меняем.
UPDATE public.datasets d
   SET settings = d.settings || '{"historyRetentionDays": 90}'::jsonb
 WHERE d.id IN (SELECT s.dataset_id FROM public.sources s
                 WHERE s.kind = 'feed' AND s.dataset_id IS NOT NULL)
   AND (d.settings->>'trackHistory')::boolean IS DISTINCT FROM false
   AND NOT (d.settings ? 'historyRetentionDays');
