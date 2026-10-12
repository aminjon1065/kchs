import { eq } from 'drizzle-orm'
import { objects } from '~/kernel/objects/schema.js'
import { registerProcessObjectProvider, registerProcessWaitEvent } from '~/kernel/process/index.js'
import { db, type Executor } from '~/shared/db/client.js'
import { warnings } from '../schema.js'
import { WarningPublication } from './publication.js'
import { WarningService } from './warning-service.js'
import { statusOf, WarningStore } from './warning-store.js'

/** Исходы, которые решения о выпуске не дают. */
const NEGATIVE = new Set(['rejected', 'refused', 'withdrawn', 'cancelled', 'timeout'])

/**
 * Данные предупреждения для назначений и условий маршрута: подписывающий —
 * `field:signer`, автор — `author`; строгость, срочность и вид сообщения — для
 * условий (`object.severity = 'Extreme'`).
 */
async function load(executor: Executor, id: string) {
  const [row] = await executor
    .select({
      authorId: warnings.authorId,
      signerId: warnings.signerId,
      status: warnings.status,
      msgType: warnings.msgType,
      capStatus: warnings.capStatus,
      severity: warnings.severity,
      urgency: warnings.urgency,
      certainty: warnings.certainty,
      spaceId: objects.spaceId,
      title: objects.title,
    })
    .from(warnings)
    .innerJoin(objects, eq(objects.id, warnings.id))
    .where(eq(warnings.id, id))
    .limit(1)
  if (!row) return null
  return {
    authorId: row.authorId,
    spaceId: row.spaceId,
    title: row.title,
    fields: { signer: row.signerId, author: row.authorId },
    props: {
      status: row.status,
      msgType: row.msgType,
      capStatus: row.capStatus,
      severity: row.severity,
      urgency: row.urgency,
      certainty: row.certainty,
    },
  }
}

/**
 * Выпуск предупреждения на движке процессов (ADR-0202), как маршруты документов
 * (ADR-0083): первый активный шаг — «на утверждении»; подпись уполномоченного
 * лица — решение о выпуске и публикация в той же транзакции; маршрут, который
 * кончился без подписи или отказом, возвращает черновик.
 */
export function registerWarningProcess(): void {
  registerProcessObjectProvider({
    objectType: 'warning',
    load,
    fieldHints: async () => [
      {
        path: 'signer',
        label: { ru: 'Подписывает', tg: 'Имзо мекунад', en: 'Signer' },
        type: 'user',
      },
      { path: 'author', label: { ru: 'Автор', tg: 'Муаллиф', en: 'Author' }, type: 'user' },
    ],
    canStart: async (ctx, id) => {
      await WarningService.assertCanSubmit(db(), ctx, id)
    },
    onStepActivated: async (tx, ctx, { instance }) => {
      await WarningPublication.onApproval(tx, ctx, instance.objectId, instance.id)
    },
    onStepCompleted: async (tx, ctx, { instance, step }) => {
      if (step.type !== 'sign' || !step.outcome || NEGATIVE.has(step.outcome)) return
      await WarningPublication.publish(tx, ctx, instance.objectId)
    },
    onFinished: async (tx, ctx, { instance, status, outcome }) => {
      const row = await WarningStore.load(tx, instance.objectId)
      if (!row || statusOf(row) !== 'on_approval') return
      // Маршрут, изменённый администратором без шага подписи, — решение всем маршрутом
      if (status === 'finished' && !NEGATIVE.has(outcome)) {
        await WarningPublication.publish(tx, ctx, instance.objectId)
      } else {
        await WarningPublication.returnToDraft(tx, ctx, instance.objectId, outcome)
      }
    },
  })

  // Маршрут может ждать выхода предупреждения (например, уведомить после публикации)
  registerProcessWaitEvent('warning.published')
}
