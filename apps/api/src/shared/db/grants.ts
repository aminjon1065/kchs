import type { Sql } from 'postgres'

/**
 * Партиции `audit_log` создаёт kchs_migrator, и права по умолчанию (и `GRANT … ON
 * ALL TABLES` ниже) дают на них приложению правку и удаление — в обход родителя,
 * на котором запись закрыта. Запись в партиции закрывается для всех ролей
 * приложения; вставка идёт через родителя (Postgres не проверяет права партиции
 * при маршрутизации строки), чтение остаётся — его просит `pg_dump` резервной
 * копии (ADR-0173). Выполняется после каждой синхронизации привилегий и после
 * создания партиций.
 */
export const AUDIT_PARTITIONS_APPEND_ONLY = `DO $$
DECLARE part regclass;
BEGIN
  IF to_regclass('public.audit_log') IS NULL THEN RETURN; END IF;
  FOR part IN SELECT inhrelid::regclass FROM pg_inherits WHERE inhparent = 'public.audit_log'::regclass LOOP
    EXECUTE format(
      'REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE %s FROM PUBLIC, kchs_app, kchs_audit, kchs_readonly',
      part
    );
  END LOOP;
END $$`

/**
 * Журнал миграций пишет только мигратор (ADR-0187): `GRANT … ON ALL TABLES` ниже
 * давал приложению правку и удаление его строк, то есть возможность скрыть или
 * подделать применённую миграцию. Чтение остаётся — его просит `pg_dump` резервной
 * копии ролью kchs_app. Если миграции идут ролью kchs_app (нет
 * `DATABASE_MIGRATOR_URL`), отзыв пропускается: приложение не отнимает права у себя.
 */
export const MIGRATIONS_JOURNAL_READ_ONLY = `DO $$
BEGIN
  IF to_regclass('public.__migrations') IS NULL OR current_user = 'kchs_app' THEN RETURN; END IF;
  REVOKE ALL ON TABLE public.__migrations FROM PUBLIC, kchs_app, kchs_audit, kchs_readonly;
  GRANT SELECT ON TABLE public.__migrations TO kchs_app, kchs_readonly;
END $$`

/**
 * Синхронизация привилегий после миграций. Выполняется ролью kchs_migrator,
 * которая владеет созданными таблицами.
 *
 * Правила (05-data-model.md §Роли БД, 17-security.md §4):
 *  • kchs_app      — DML во всех схемах платформы, кроме audit_log (только INSERT/SELECT)
 *  • kchs_query    — только SELECT в схеме ds, ничего в public
 *  • kchs_readonly — SELECT в public/ds/ops
 *  • kchs_audit    — только INSERT в audit_log
 */
export const GRANT_STATEMENTS: string[] = [
  // ── kchs_app ───────────────────────────────────────────────────────────────
  `GRANT USAGE, CREATE ON SCHEMA public, ops, yjs, ds TO kchs_app`,
  `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public, ops, yjs TO kchs_app`,
  `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public, ops, yjs TO kchs_app`,
  `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ops TO kchs_app`,
  `ALTER DEFAULT PRIVILEGES FOR ROLE kchs_migrator IN SCHEMA public, ops, yjs
     GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO kchs_app`,
  `ALTER DEFAULT PRIVILEGES FOR ROLE kchs_migrator IN SCHEMA public, ops, yjs
     GRANT USAGE, SELECT ON SEQUENCES TO kchs_app`,

  // ── kchs_readonly ─────────────────────────────────────────────────────────
  `GRANT USAGE ON SCHEMA public, ops, ds TO kchs_readonly`,
  `GRANT SELECT ON ALL TABLES IN SCHEMA public, ops TO kchs_readonly`,
  `ALTER DEFAULT PRIVILEGES FOR ROLE kchs_migrator IN SCHEMA public, ops, ds
     GRANT SELECT ON TABLES TO kchs_readonly`,

  // ── kchs_query: никакого доступа к public (критерий приёмки P0-E02) ───────
  `REVOKE ALL ON ALL TABLES IN SCHEMA public, ops, yjs FROM kchs_query`,
  `REVOKE ALL ON SCHEMA public, ops, yjs FROM kchs_query`,
  `GRANT USAGE ON SCHEMA ds TO kchs_query`,
  `ALTER DEFAULT PRIVILEGES FOR ROLE kchs_migrator IN SCHEMA ds GRANT SELECT ON TABLES TO kchs_query`,

  // ── audit_log неизменяем: только добавление ───────────────────────────────
  `REVOKE ALL ON TABLE public.audit_log FROM PUBLIC, kchs_app, kchs_audit, kchs_readonly`,
  `GRANT INSERT, SELECT ON TABLE public.audit_log TO kchs_app`,
  `GRANT INSERT ON TABLE public.audit_log TO kchs_audit`,
  `GRANT SELECT ON TABLE public.audit_log TO kchs_readonly`,
  `GRANT USAGE ON SCHEMA public TO kchs_audit`,
  AUDIT_PARTITIONS_APPEND_ONLY,

  // ── журнал миграций — только мигратору ───────────────────────────────────
  MIGRATIONS_JOURNAL_READ_ONLY,
]

export async function applyGrants(sql: Sql): Promise<void> {
  for (const statement of GRANT_STATEMENTS) {
    await sql.unsafe(statement)
  }
}
