import { and, eq, isNull, lte, sql } from 'drizzle-orm'
import { db } from '~/shared/db/client.js'
import { alertEvents, alerts, objects } from '~/shared/db/schema/index.js'
import { logger } from '~/shared/logger/index.js'
import { AlertCheck } from './alert-check.js'
import { AlertService, computeNextRun } from './alert-service.js'

/**
 * Проверка алертов (ADR-0104) — одно объявленное задание единого планировщика
 * (ADR-0096): тик выбирает алерты, у которых подошёл срок по их выражению cron,
 * и проверяет их. Собственного планировщика у алертов нет.
 */

/** Алертов за один тик — не больше: остальные подождут следующего. */
const BATCH = 50

export const AlertJobs = {
  async tick(now: Date = new Date()): Promise<{ checked: number; fired: number }> {
    const rows = await db()
      .select({ id: alerts.id })
      .from(alerts)
      .innerJoin(objects, eq(objects.id, alerts.id))
      .where(
        and(
          eq(alerts.enabled, true),
          isNull(objects.deletedAt),
          isNull(objects.archivedAt),
          lte(alerts.nextRunAt, now.toISOString()),
        ),
      )
      .limit(BATCH)

    let checked = 0
    let fired = 0
    for (const { id } of rows) {
      const row = await AlertService.load(db(), id)
      if (!row) continue
      // Время следующей проверки ставим до самой проверки: упавший алерт не
      // повторяется в каждом тике
      await db()
        .update(alerts)
        .set({ nextRunAt: computeNextRun(AlertService.definitionOf(row)) })
        .where(eq(alerts.id, id))
      try {
        const result = await AlertCheck.run(row, { dryRun: false })
        checked += 1
        fired += result.fired
      } catch (error) {
        logger().warn({ err: error, alertId: id }, 'проверка алерта не выполнена')
      }
    }
    return { checked, fired }
  },

  /** Старые срабатывания: столько же, сколько журнал правил автоматизации. */
  async prune(days = 180): Promise<number> {
    const rows = await db()
      .delete(alertEvents)
      .where(sql`${alertEvents.firedAt} < now() - make_interval(days => ${days})`)
      .returning({ id: alertEvents.id })
    return rows.length
  },
}
