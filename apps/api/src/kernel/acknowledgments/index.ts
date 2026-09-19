/**
 * Ознакомление — механизм ядра (08-documents.md §10, ADR-0084), публичный API
 * для модулей:
 *
 * - `Acknowledgments.request(tx, ctx, {objectId, source, userIds, unitIds,
 *   groupIds, dueAt, requireSecondFactor, note})` — запрос в транзакции модуля
 *   (права получателей выдаёт модуль типа: документы — участниками);
 * - `Acknowledgments.acknowledge`, `remind`, `list`, `usersOf`, `pendingFor`;
 * - шаг маршрута `acknowledge` пишет в тот же учёт наблюдателем движка.
 */
import { and, isNull, lt, or, sql } from 'drizzle-orm'
import { systemCtx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { acknowledgments } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { registerInboxActionHandler } from '../inbox/actions.js'
import { registerProcessObserver } from '../process/registry.js'
import { ProcessService } from '../process/service.js'
import { processAcknowledgments } from './process.js'
import { Acknowledgments } from './service.js'

export {
  type AcknowledgmentRequestOutcome,
  type AcknowledgmentRequestSpec,
  Acknowledgments,
} from './service.js'
export { acknowledgmentSubscribers } from './subscribers.js'

/** Напоминание в день срока и после него — не чаще раза в сутки одному сотруднику. */
const AUTO_REMIND_INTERVAL_MS = 20 * 60 * 60 * 1000

/**
 * Дела `acknowledge` — одним путём из Входящих, Telegram и API: дело шага
 * маршрута — решение шага (`ProcessService.act`), дело запроса — отметка
 * (с кодом второго фактора из `payload.code`, если его требует запрос).
 * Учёт шага ведёт наблюдатель движка в той же транзакции.
 */
export function registerAcknowledgments(): void {
  registerProcessObserver(processAcknowledgments)
  registerInboxActionHandler('acknowledge', async (ctx, { item, action, payload }) => {
    if (action !== 'acknowledge' || !item.objectId) {
      throw errors.validation('Нет такого действия у элемента Входящих')
    }
    const objectId = item.objectId
    const stepId = item.processStepId
    if (stepId) {
      await db().transaction((tx) => ProcessService.act(tx, ctx, { stepId, action: 'acknowledge' }))
      return
    }
    const code = typeof payload?.code === 'string' ? payload.code : undefined
    await db().transaction((tx) =>
      Acknowledgments.acknowledge(tx, ctx, objectId, code ? { code } : {}),
    )
  })
}

/**
 * Обход напоминаний (задание `acknowledgments.remind`): не ознакомившимся, у
 * кого срок сегодня или уже прошёл, — раз в сутки.
 */
export async function remindDueAcknowledgments(now = new Date()): Promise<number> {
  const endOfDay = new Date(now)
  endOfDay.setHours(23, 59, 59, 999)
  const due = await db()
    .selectDistinct({ objectId: acknowledgments.objectId, userId: acknowledgments.userId })
    .from(acknowledgments)
    .where(
      and(
        isNull(acknowledgments.acknowledgedAt),
        isNull(acknowledgments.cancelledAt),
        sql`${acknowledgments.dueAt} IS NOT NULL`,
        lt(acknowledgments.dueAt, endOfDay.toISOString()),
        or(
          isNull(acknowledgments.remindedAt),
          lt(
            acknowledgments.remindedAt,
            new Date(now.getTime() - AUTO_REMIND_INTERVAL_MS).toISOString(),
          ),
        ),
      ),
    )
  const byObject = new Map<string, string[]>()
  for (const row of due)
    byObject.set(row.objectId, [...(byObject.get(row.objectId) ?? []), row.userId])
  let reminded = 0
  const ctx = systemCtx('acknowledgments.remind')
  for (const [objectId, userIds] of byObject) {
    const done = await db().transaction((tx) =>
      Acknowledgments.remind(tx, ctx, objectId, { userIds, auto: true }),
    )
    reminded += done.length
  }
  return reminded
}
