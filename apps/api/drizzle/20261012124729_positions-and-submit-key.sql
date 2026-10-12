CREATE TABLE "device_positions" (
	"device_id" uuid NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lat" double precision NOT NULL,
	"lon" double precision NOT NULL,
	"speed" real,
	"heading" real,
	"battery" real,
	"source" text NOT NULL,
	CONSTRAINT "device_positions_pk" PRIMARY KEY("device_id","at")
) PARTITION BY RANGE ("at");
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"external_id" text NOT NULL,
	"kind" text DEFAULT 'vehicle' NOT NULL,
	"forces_code" text,
	"unit_id" uuid,
	"reporter_id" uuid,
	"note" text,
	"active" boolean DEFAULT true NOT NULL,
	"last_at" timestamp with time zone,
	"last_lat" double precision,
	"last_lon" double precision,
	"last_speed" real,
	"last_heading" real,
	"last_battery" real,
	"projected_at" timestamp with time zone,
	"projected_link" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "form_submissions" ADD COLUMN "submit_key" uuid;--> statement-breakpoint
ALTER TABLE "device_positions" ADD CONSTRAINT "device_positions_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_id_objects_id_fk" FOREIGN KEY ("id") REFERENCES "public"."objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_unit_id_org_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."org_units"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_reporter_id_users_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "devices_external_uq" ON "devices" USING btree ("external_id");--> statement-breakpoint
CREATE INDEX "devices_last_idx" ON "devices" USING btree ("last_at");--> statement-breakpoint
CREATE INDEX "devices_reporter_idx" ON "devices" USING btree ("reporter_id");--> statement-breakpoint
-- ADR-0203: журнал точек разбит на месяцы, как журнал аудита (ADR-0173). Партиции на
-- прошлый, текущий и три следующих месяца; дальше их создаёт задание обслуживания
-- модуля, оно же удаляет месяцы старше срока хранения. «Хвостовая» партиция ловит
-- точки вне диапазона (давняя отложенная отправка), чтобы приём не падал.
DO $$
DECLARE m date;
BEGIN
  FOR m IN SELECT generate_series(
      date_trunc('month', now() - interval '1 month'),
      date_trunc('month', now() + interval '3 month'),
      interval '1 month')::date
  LOOP
    PERFORM ops.ensure_month_partition('public.device_positions'::regclass, m);
  END LOOP;
  IF to_regclass('public.device_positions_default') IS NULL THEN
    CREATE TABLE public.device_positions_default PARTITION OF public.device_positions DEFAULT;
  END IF;
END $$;
--> statement-breakpoint
-- Месячные партиции целиком старше месяца отсечки удаляются, из «хвостовой» —
-- строки старше отсечки. Выполняет владелец таблицы (kchs_migrator).
CREATE OR REPLACE FUNCTION ops.drop_month_partitions_before(p_table regclass, p_before date)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  part record;
  base_name text;
  part_month date;
  dropped integer := 0;
BEGIN
  SELECT relname INTO base_name FROM pg_class WHERE oid = p_table;
  FOR part IN
    SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
     WHERE i.inhparent = p_table
       AND c.relname ~ ('^' || base_name || '_[0-9]{4}_[0-9]{2}$')
  LOOP
    part_month := to_date(right(part.relname, 7), 'YYYY_MM');
    IF part_month + interval '1 month' <= date_trunc('month', p_before) THEN
      EXECUTE format('DROP TABLE public.%I', part.relname);
      dropped := dropped + 1;
    END IF;
  END LOOP;
  IF to_regclass('public.' || base_name || '_default') IS NOT NULL THEN
    EXECUTE format('DELETE FROM public.%I WHERE at < %L', base_name || '_default', p_before);
  END IF;
  RETURN dropped;
END $$;
