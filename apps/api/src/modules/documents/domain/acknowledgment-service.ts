import type {
  AcknowledgmentRequestInput,
  AcknowledgmentRequestResult,
  DocumentStatus,
} from '@kchs/contracts'
import { authorize } from '~/kernel/access/authorize.js'
import { Acknowledgments } from '~/kernel/acknowledgments/index.js'
import { BusinessCalendar } from '~/kernel/business-calendar/service.js'
import { endOfLocalDay } from '~/kernel/business-calendar/working-days.js'
import { directory } from '~/kernel/directory/port.js'
import { config } from '~/shared/config/index.js'
import type { Ctx } from '~/shared/context.js'
import type { Executor } from '~/shared/db/client.js'
import { errors } from '~/shared/errors.js'
import { DocumentService } from './document-service.js'
import { DocumentParticipants } from './participants.js'
import { DocumentTypeService } from './type-service.js'

/** Знакомят с документом после регистрации: черновик и аннулированный — нет. */
const ACKNOWLEDGEABLE: readonly DocumentStatus[] = [
  'registered',
  'on_execution',
  'executed',
  'filed',
  'archived',
]

/** Источник участия: всех, кого просили ознакомиться, документ пускает на просмотр. */
const PARTICIPANT_SOURCE = 'acknowledgment'

/**
 * Ознакомление с документом (08-documents.md §10, ADR-0084) — механизм ядра
 * (`kernel/acknowledgments`); модуль документов решает, когда и кого знакомить,
 * и выдаёт получателям право просмотра участием `acknowledgment`. Код второго
 * фактора и срок по умолчанию — правило типа (`ackRequireMfa`,
 * `ackDueWorkingDays`).
 */
export const DocumentAcknowledgments = {
  async request(
    tx: Executor,
    ctx: Ctx,
    documentId: string,
    input: AcknowledgmentRequestInput,
    source: 'manual' | 'register' = 'manual',
  ): Promise<AcknowledgmentRequestResult> {
    if (source === 'manual') await authorize(ctx, 'request_acknowledgment', documentId)
    const document = await DocumentService.load(tx, documentId, true)
    if (!document) throw errors.notFound('Документ')
    if (!ACKNOWLEDGEABLE.includes(document.status as DocumentStatus)) {
      throw errors.conflict('С документом знакомят после регистрации', {
        status: document.status,
      })
    }
    const type = await DocumentTypeService.load(tx, document.typeId)
    if (!type) throw errors.notFound('Тип документа')

    const dueAt = input.dueDate
      ? endOfLocalDay(input.dueDate, config().TZ)
      : type.settings.ackDueWorkingDays
        ? (
            await BusinessCalendar.deadline(new Date(), type.settings.ackDueWorkingDays, {
              executor: tx,
            })
          ).dueAt
        : null
    const outcome = await Acknowledgments.request(tx, ctx, {
      objectId: documentId,
      source,
      userIds: input.userIds,
      unitIds: input.unitIds,
      groupIds: input.groupIds,
      dueAt,
      requireSecondFactor: input.requireSecondFactor ?? type.settings.ackRequireMfa,
      note: input.note,
    })
    if (outcome.added.length > 0) {
      const users = await Acknowledgments.usersOf(tx, documentId)
      await DocumentParticipants.sync(
        tx,
        ctx,
        documentId,
        PARTICIPANT_SOURCE,
        users.map((userId) => ({
          userId,
          role: 'acknowledgment' as const,
          level: 'view' as const,
        })),
      )
    }
    const refs = await directory().refs(outcome.skipped.map((item) => item.userId))
    return {
      requestId: outcome.requestId,
      added: outcome.added.length,
      skipped: outcome.skipped.flatMap((item) => {
        const user = refs.get(item.userId)
        return user ? [{ user, reason: item.reason }] : []
      }),
    }
  },

  /**
   * Ознакомление при регистрации (правило типа `ackOnRegister`): подразделения
   * типа, а без них — подразделение документа; в транзакции регистрации.
   */
  async onRegistered(tx: Executor, ctx: Ctx, documentId: string): Promise<void> {
    const document = await DocumentService.load(tx, documentId)
    if (!document) return
    const type = await DocumentTypeService.load(tx, document.typeId)
    if (!type?.settings.ackOnRegister) return
    const unitIds =
      type.settings.ackUnitIds.length > 0
        ? type.settings.ackUnitIds
        : document.unitId
          ? [document.unitId]
          : []
    if (unitIds.length === 0) return
    await DocumentAcknowledgments.request(
      tx,
      ctx,
      documentId,
      { userIds: [], unitIds, groupIds: [], dueDate: null, note: null },
      'register',
    )
  },
}
