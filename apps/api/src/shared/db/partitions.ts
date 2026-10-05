import type { Sql } from 'postgres'
import { AUDIT_PARTITIONS_APPEND_ONLY } from './grants.js'

/** Блокировка обслуживания партиций: реплики и задание не делают его одновременно. */
const PARTITIONS_LOCK_ID = 725_130_003

/** Ожидание блокировки родителя: дольше — вставки аудита встают в очередь за ним. */
const LOCK_TIMEOUT = '10s'

export interface PartitionReport {
  /** Созданные партиции. */
  created: string[]
  /** Строки, перенесённые из партиции по умолчанию в свою партицию месяца. */
  moved: number
  /** Таблица не разбита на партиции — обслуживать нечего. */
  skipped?: 'not_partitioned'
}

/**
 * Месячные партиции журнала аудита (17-security.md §6, ADR-0173): на текущий и
 * `monthsAhead` следующих месяцев и на каждый месяц, строки которого оказались в
 * `audit_log_default` (обслуживание долго не работало). Такие строки переносятся
 * в свою партицию в той же транзакции, где она создаётся: иначе Postgres не даст
 * её создать. Выполняет владелец таблицы — kchs_migrator: создавать партиции и
 * переносить строки может только он, приложению аудит доступен лишь на добавление.
 * Повторный и параллельный запуск безопасен: месяц создаётся под блокировкой.
 */
export async function ensureAuditPartitions(sql: Sql, monthsAhead = 3): Promise<PartitionReport> {
  const [table] = await sql<{ kind: string | null; fallback: boolean }[]>`
    SELECT (SELECT relkind::text FROM pg_class WHERE oid = to_regclass('public.audit_log')) AS kind,
           to_regclass('public.audit_log_default') IS NOT NULL AS fallback`
  if (table?.kind !== 'p') return { created: [], moved: 0, skipped: 'not_partitioned' }

  // Месяцы строк в партиции по умолчанию — только если она есть: имя таблицы
  // разбирается до выполнения, и запрос к несуществующей упал бы
  const strayMonths = table.fallback
    ? sql`UNION SELECT DISTINCT date_trunc('month', occurred_at) FROM public.audit_log_default`
    : sql``
  const months = await sql<{ month: string; name: string }[]>`
    WITH wanted AS (
      SELECT generate_series(
               date_trunc('month', now()),
               date_trunc('month', now()) + make_interval(months => ${monthsAhead}),
               interval '1 month') AS m
      ${strayMonths}
    )
    SELECT to_char(m, 'YYYY-MM-DD') AS month, 'audit_log_' || to_char(m, 'YYYY_MM') AS name
      FROM wanted
     WHERE to_regclass('public.audit_log_' || to_char(m, 'YYYY_MM')) IS NULL
     ORDER BY m`

  const report: PartitionReport = { created: [], moved: 0 }
  for (const month of months) {
    const moved = await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(${PARTITIONS_LOCK_ID})`
      // Пока ждали блокировку, месяц мог создать другой процесс
      const [current] = await tx<{ exists: boolean }[]>`
        SELECT to_regclass(${`public.${month.name}`}) IS NOT NULL AS exists`
      if (current?.exists) return null
      await tx`SELECT set_config('lock_timeout', ${LOCK_TIMEOUT}, true)`
      if (table.fallback) {
        // Вставки, которые уходят в партицию по умолчанию, ждут: подсчёт ниже точен.
        // Вставки в партиции месяцев идут, как шли
        await tx`LOCK TABLE public.audit_log_default IN SHARE ROW EXCLUSIVE MODE`
      }
      const [stray] = table.fallback
        ? await tx<{ n: number }[]>`
            SELECT count(*)::int AS n FROM public.audit_log_default
             WHERE occurred_at >= ${month.month}::date
               AND occurred_at < ${month.month}::date + interval '1 month'`
        : [{ n: 0 }]
      const strays = stray?.n ?? 0
      if (strays === 0) {
        await tx`SELECT ops.ensure_month_partition('public.audit_log'::regclass, ${month.month}::date)`
        return 0
      }
      // Строки месяца лежат в партиции по умолчанию: она отсоединяется на время
      // переноса, строки уходят в новую партицию с прежними id и временем
      await tx`ALTER TABLE public.audit_log DETACH PARTITION public.audit_log_default`
      await tx`SELECT ops.ensure_month_partition('public.audit_log'::regclass, ${month.month}::date)`
      await tx`
        INSERT INTO public.audit_log OVERRIDING SYSTEM VALUE
        SELECT * FROM public.audit_log_default
         WHERE occurred_at >= ${month.month}::date
           AND occurred_at < ${month.month}::date + interval '1 month'`
      await tx`
        DELETE FROM public.audit_log_default
         WHERE occurred_at >= ${month.month}::date
           AND occurred_at < ${month.month}::date + interval '1 month'`
      await tx`ALTER TABLE public.audit_log ATTACH PARTITION public.audit_log_default DEFAULT`
      return strays
    })
    if (moved === null) continue
    report.created.push(month.name)
    report.moved += moved
  }
  // Права по умолчанию дают приложению запись в новые партиции — закрываем сразу
  if (report.created.length > 0) await sql.unsafe(AUDIT_PARTITIONS_APPEND_ONLY)
  return report
}
