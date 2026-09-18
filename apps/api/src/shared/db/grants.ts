import type { Sql } from 'postgres'

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
]

export async function applyGrants(sql: Sql): Promise<void> {
  for (const statement of GRANT_STATEMENTS) {
    await sql.unsafe(statement)
  }
}
