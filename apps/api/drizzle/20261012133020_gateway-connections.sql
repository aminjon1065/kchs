CREATE TABLE "edms_sends" (
	"id" uuid PRIMARY KEY NOT NULL,
	"document_id" uuid NOT NULL,
	"version_no" integer,
	"recipient" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"external_id" text,
	"error" text,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "edms_sends_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "integration_connections" (
	"subject_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"owner_id" uuid,
	"first_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_at" timestamp with time zone,
	"last_error_at" timestamp with time zone,
	"last_error" text,
	CONSTRAINT "integration_connections_subject_id_channel_pk" PRIMARY KEY("subject_id","channel")
);
--> statement-breakpoint
CREATE TABLE "integration_usage_daily" (
	"subject_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"day" date NOT NULL,
	"requests" bigint DEFAULT 0 NOT NULL,
	"rows" bigint DEFAULT 0 NOT NULL,
	"errors" bigint DEFAULT 0 NOT NULL,
	"last_at" timestamp with time zone,
	CONSTRAINT "integration_usage_daily_subject_id_channel_day_pk" PRIMARY KEY("subject_id","channel","day")
);
--> statement-breakpoint
ALTER TABLE "edms_sends" ADD CONSTRAINT "edms_sends_document_id_objects_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edms_sends" ADD CONSTRAINT "edms_sends_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "edms_sends_document_idx" ON "edms_sends" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "edms_sends_due_idx" ON "edms_sends" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "integration_usage_daily_day_idx" ON "integration_usage_daily" USING btree ("day");--> statement-breakpoint
-- Системный датасет «Подключения» (ADR-0206): строка — подключение за сутки последних
-- 60 дней, включая дни без передач (пропуски видны нулями). «Сегодня» — по часовому поясу
-- установки (переменная TZ api, по умолчанию Asia/Dushanbe; как у пересмотра страниц).
-- Выпущенные, но ещё не использованные токены — тоже подключения: «выдан и молчит».
-- Политика строк смотрящего — в коде модуля интеграций: управляющие интеграциями видят
-- всё, владелец токена — свои строки
CREATE VIEW "ds"."sys_connections" AS
WITH conn AS (
  SELECT c.subject_id, c.channel, c.kind, c.title, c.owner_id, c.first_at, c.last_at,
         c.last_error_at, c.last_error
  FROM integration_connections c
  UNION ALL
  SELECT t.id, 'api', 'token', t.name, t.user_id, t.created_at, NULL, NULL, NULL
  FROM api_tokens t
  WHERE t.revoked_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM integration_connections c WHERE c.subject_id = t.id AND c.channel = 'api'
    )
),
today AS (SELECT (now() AT TIME ZONE 'Asia/Dushanbe')::date AS d),
state AS (
  SELECT conn.*,
    (conn.first_at AT TIME ZONE 'Asia/Dushanbe')::date AS first_day,
    COALESCE(
      CASE WHEN t.id IS NOT NULL AND t.revoked_at IS NOT NULL THEN 'revoked' END,
      CASE WHEN t.id IS NOT NULL AND t.expires_at < now() THEN 'expired' END,
      CASE WHEN o.deleted_at IS NOT NULL THEN 'deleted' END,
      CASE WHEN w.id IS NOT NULL AND w.status <> 'active' THEN w.status END,
      CASE WHEN i.id IS NOT NULL AND NOT i.enabled THEN 'disabled' END,
      'active'
    ) AS status,
    (SELECT count(*) FROM integration_usage_daily u, today
      WHERE u.subject_id = conn.subject_id AND u.channel = conn.channel
        AND u.day > today.d - 30 AND (u.requests > 0 OR u.rows > 0))::int AS active_days_30
  FROM conn
  LEFT JOIN api_tokens t ON conn.kind = 'token' AND t.id = conn.subject_id
  LEFT JOIN objects o ON o.id = conn.subject_id
  LEFT JOIN webhooks w ON conn.kind = 'webhook' AND w.id = conn.subject_id
  LEFT JOIN integrations i ON conn.kind = 'integration' AND i.id = conn.subject_id
)
SELECT
  days.day,
  s.subject_id::text AS connection_id,
  s.title AS connection,
  s.kind,
  s.channel,
  s.owner_id AS owner,
  s.status,
  s.first_at AS since,
  COALESCE(u.requests, 0)::bigint AS requests,
  COALESCE(u.rows, 0)::bigint AS rows,
  COALESCE(u.errors, 0)::bigint AS errors,
  (COALESCE(u.requests, 0) + COALESCE(u.rows, 0) > 0) AS active,
  s.last_at,
  round((extract(epoch FROM now() - s.last_at) / 3600)::numeric, 1) AS hours_since_last,
  (s.status = 'active' AND (s.last_at IS NULL OR s.last_at < now() - interval '24 hours')) AS stale,
  s.active_days_30,
  round(100.0 * s.active_days_30
    / greatest(1, least(30, (SELECT d FROM today) - s.first_day + 1)))::int AS completeness,
  s.last_error,
  s.last_error_at,
  (days.day = (SELECT d FROM today)) AS is_today
FROM state s
CROSS JOIN LATERAL (
  SELECT g::date AS day
  FROM generate_series(
    greatest(s.first_day, (SELECT d FROM today) - 59)::timestamp,
    (SELECT d FROM today)::timestamp,
    interval '1 day'
  ) AS g
) AS days
LEFT JOIN integration_usage_daily u
  ON u.subject_id = s.subject_id AND u.channel = s.channel AND u.day = days.day;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kchs_query') THEN
    GRANT SELECT ON "ds"."sys_connections" TO kchs_query;
  END IF;
END $$;