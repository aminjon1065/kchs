import type { EventEnvelope } from '@kchs/contracts'
import { eq, inArray } from 'drizzle-orm'
import { LinkService } from '~/kernel/links/service.js'
import { Instructions } from '~/modules/tasks/public.js'
import { systemCtx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { documents, resolutions } from '~/shared/db/schema/index.js'
import { CorrespondentService } from './correspondent-service.js'

/** «2026-09-25» → «25.09.2026». */
function ruDate(date: string): string {
  const [year, month, day] = date.split('-')
  return `${day}.${month}.${year}`
}

/**
 * Готовый отчёт по поручению после отправки ответа (N22, ADR-0136). Первая отметка об отправке
 * исходящего, связанного «в ответ на» с входящим, готовит отчёт с номером исходящего. Получает
 * его исполнитель поручения по резолюции входящего: он отправляет отчёт одной кнопкой, а
 * принимает автор резолюции.
 *
 * Исполнитель — автор или ответственный исходящего. Если он не исполнитель ни одного
 * поручения, а открытое основное поручение одно, отчёт получает его исполнитель. Повтор события
 * отчёт заново не готовит.
 */
export async function prepareReplyReports(event: EventEnvelope): Promise<number> {
  const outgoingId = event.object?.id
  if (!outgoingId || event.payload.first !== true) return 0
  const [outgoing] = await db()
    .select({
      regNumber: documents.regNumber,
      regDate: documents.regDate,
      authorId: documents.authorId,
      responsibleId: documents.responsibleId,
      correspondentId: documents.correspondentId,
    })
    .from(documents)
    .where(eq(documents.id, outgoingId))
    .limit(1)
  if (!outgoing?.regNumber) return 0

  const incomingIds = (await LinkService.edges([outgoingId], 'reply_to'))
    .filter((edge) => edge.sourceId === outgoingId)
    .map((edge) => edge.targetId)
  if (incomingIds.length === 0) return 0
  const taskIds = (
    await db()
      .select({ ids: resolutions.instructionIds })
      .from(resolutions)
      .where(inArray(resolutions.documentId, incomingIds))
  ).flatMap((row) => row.ids)
  const open = await Instructions.open(taskIds)
  if (open.length === 0) return 0

  const executors = new Set(
    [outgoing.authorId, outgoing.responsibleId].filter((id): id is string => id !== null),
  )
  let targets = open.filter((task) => task.assigneeId !== null && executors.has(task.assigneeId))
  if (targets.length === 0) {
    const mains = open.filter((task) => task.parentId === null)
    if (mains.length === 1) targets = mains
  }
  if (targets.length === 0) return 0

  const correspondent = outgoing.correspondentId
    ? (await CorrespondentService.names(db(), [outgoing.correspondentId])).get(
        outgoing.correspondentId,
      )?.name
    : null
  const date = outgoing.regDate ? ` от ${ruDate(outgoing.regDate)}` : ''
  const text = `Подготовлен и отправлен ответ: исх. № ${outgoing.regNumber}${date}${
    correspondent ? `, ${correspondent}` : ''
  }.`
  const ctx = systemCtx('documents.reply-report', { initiatorId: event.actor.userId })
  let prepared = 0
  await db().transaction(async (tx) => {
    for (const task of targets) {
      const done = await Instructions.prepareReport(tx, ctx, task.id, {
        text,
        objectIds: [outgoingId],
        cause: 'reply_dispatched',
        sourceObjectId: outgoingId,
      })
      if (done) prepared += 1
    }
  })
  return prepared
}
