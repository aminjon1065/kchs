-- Доставка уведомлений по e-mail: немедленно и дайджестом
-- (02-platform-kernel.md §7, backlog P0-E09 S01).

ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS emailed_at timestamptz;

-- Выборка «что ещё не отправлено почтой»: только непрочитанные с каналом email
CREATE INDEX IF NOT EXISTS notifications_email_pending_idx
  ON public.notifications (user_id, created_at)
  WHERE emailed_at IS NULL AND read_at IS NULL;
