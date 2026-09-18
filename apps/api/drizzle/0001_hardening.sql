-- Ужесточение после создания схемы ядра:
--  1) audit_log — партиционирование по месяцам и неизменяемость (17-security.md §6)
--  2) функция создания месячных партиций для задания обслуживания

-- 1. Партиционирование audit_log ---------------------------------------------
DO $$
DECLARE
  has_rows boolean;
  is_part  boolean;
BEGIN
  SELECT relkind = 'p' INTO is_part FROM pg_class WHERE relname = 'audit_log' AND relnamespace = 'public'::regnamespace;
  IF is_part THEN RETURN; END IF;

  EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.audit_log LIMIT 1)' INTO has_rows;
  IF has_rows THEN
    RAISE NOTICE 'audit_log содержит данные — партиционирование выполняется отдельным заданием обслуживания';
    RETURN;
  END IF;

  DROP TABLE public.audit_log;

  CREATE TABLE public.audit_log (
    id            bigint GENERATED ALWAYS AS IDENTITY,
    occurred_at   timestamptz NOT NULL DEFAULT now(),
    actor_id      uuid,
    on_behalf_of  uuid,
    action        text NOT NULL,
    object_id     uuid,
    object_type   text,
    ip            text,
    user_agent    text,
    details       jsonb NOT NULL DEFAULT '{}'::jsonb,
    severity      text NOT NULL DEFAULT 'info',
    CONSTRAINT audit_log_id_occurred_at_pk PRIMARY KEY (id, occurred_at)
  ) PARTITION BY RANGE (occurred_at);

  CREATE INDEX audit_log_actor_idx  ON public.audit_log (actor_id, occurred_at DESC);
  CREATE INDEX audit_log_object_idx ON public.audit_log (object_id, occurred_at DESC);
  CREATE INDEX audit_log_action_idx ON public.audit_log (action, occurred_at DESC);
END $$;
--> statement-breakpoint

-- 2. Создание месячной партиции (идемпотентно) --------------------------------
CREATE OR REPLACE FUNCTION ops.ensure_month_partition(p_table regclass, p_month date)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  base_name  text;
  part_name  text;
  from_date  date := date_trunc('month', p_month)::date;
  to_date    date := (date_trunc('month', p_month) + interval '1 month')::date;
BEGIN
  SELECT relname INTO base_name FROM pg_class WHERE oid = p_table;
  part_name := base_name || '_' || to_char(from_date, 'YYYY_MM');
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = part_name) THEN RETURN; END IF;
  EXECUTE format(
    'CREATE TABLE public.%I PARTITION OF %s FOR VALUES FROM (%L) TO (%L)',
    part_name, p_table::text, from_date, to_date
  );
END $$;
--> statement-breakpoint

-- 3. Партиции на текущий, прошлый и следующие три месяца ----------------------
DO $$
DECLARE m date;
BEGIN
  IF (SELECT relkind FROM pg_class WHERE relname = 'audit_log' AND relnamespace = 'public'::regnamespace) <> 'p' THEN
    RETURN;
  END IF;
  FOR m IN SELECT generate_series(
      date_trunc('month', now() - interval '1 month'),
      date_trunc('month', now() + interval '3 month'),
      interval '1 month')::date
  LOOP
    PERFORM ops.ensure_month_partition('public.audit_log'::regclass, m);
  END LOOP;
  -- «Хвостовая» партиция на случай записей вне диапазона
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'audit_log_default') THEN
    CREATE TABLE public.audit_log_default PARTITION OF public.audit_log DEFAULT;
  END IF;
END $$;
