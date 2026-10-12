import { withMigratorConnection } from '~/shared/db/migrate.js'
import { PositionsSettingsService } from './settings.js'

/** На сколько месяцев вперёд держать готовые партиции журнала точек. */
const MONTHS_AHEAD = 3

/**
 * Обслуживание журнала точек (ADR-0203, по образцу партиций аудита ADR-0173):
 * месячные партиции на текущий и три следующих месяца, удаление месяцев старше
 * срока хранения из настроек. Создавать и удалять партиции может только владелец
 * таблицы — kchs_migrator; приложение пишет и читает через родителя.
 */
export const PositionPartitions = {
  async maintain(now = new Date()): Promise<{ created: number; dropped: number }> {
    const settings = await PositionsSettingsService.current()
    const cutoff = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - settings.retentionMonths, 1),
    )
      .toISOString()
      .slice(0, 10)
    return withMigratorConnection(async (sql) => {
      const [before] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_inherits
         WHERE inhparent = 'public.device_positions'::regclass`
      await sql`
        SELECT ops.ensure_month_partition('public.device_positions'::regclass, m::date)
          FROM generate_series(date_trunc('month', now()),
                               date_trunc('month', now()) + make_interval(months => ${MONTHS_AHEAD}),
                               interval '1 month') AS m`
      const [after] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_inherits
         WHERE inhparent = 'public.device_positions'::regclass`
      const [dropped] = await sql<{ n: number }[]>`
        SELECT ops.drop_month_partitions_before('public.device_positions'::regclass,
                                                ${cutoff}::date) AS n`
      return {
        created: (after?.n ?? 0) - (before?.n ?? 0),
        dropped: dropped?.n ?? 0,
      }
    })
  },
}
