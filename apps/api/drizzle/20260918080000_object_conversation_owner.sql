-- Беседа объекта наследует доступ от объекта и принадлежит его владельцу.
-- Раньше владельцем беседы становился первый комментатор: запись ACL уровня
-- owner переживала отзыв его доступа к самому объекту (утечка обсуждения).
DELETE FROM public.acl_entries a
 USING public.objects c, public.conversations cv, public.objects o
 WHERE a.object_id = c.id
   AND cv.id = c.id AND cv.kind = 'object'
   AND o.id = cv.object_id
   AND c.owner_id IS DISTINCT FROM o.owner_id
   AND a.principal_type = 'user'
   AND a.principal_id = c.owner_id::text
   AND a.level = 5;
--> statement-breakpoint
UPDATE public.objects c
   SET owner_id = o.owner_id
  FROM public.conversations cv, public.objects o
 WHERE cv.id = c.id AND cv.kind = 'object'
   AND o.id = cv.object_id
   AND c.owner_id IS DISTINCT FROM o.owner_id;
--> statement-breakpoint
INSERT INTO public.acl_entries (id, object_id, principal_type, principal_id, level, granted_by)
SELECT gen_random_uuid(), c.id, 'user', c.owner_id::text, 5, c.owner_id
  FROM public.objects c
  JOIN public.conversations cv ON cv.id = c.id AND cv.kind = 'object'
 WHERE c.owner_id IS NOT NULL
ON CONFLICT (object_id, principal_type, principal_id) DO UPDATE SET level = 5;
