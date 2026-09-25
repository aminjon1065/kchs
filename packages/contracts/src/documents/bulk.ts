import { z } from 'zod'
import { Uuid } from '../common/primitives.js'
import { AcknowledgmentRequestInput } from '../objects/acknowledgment.js'

/** Сколько документов за раз: выбор в списке, а не выгрузка всего реестра. */
export const DOCUMENT_BULK_LIMIT = 200

const Ids = z.array(Uuid).min(1).max(DOCUMENT_BULK_LIMIT)

/**
 * Массовые действия в списке документов (ADR-0152): каждое проверяет права и
 * состояние по каждому документу, итог — что сделано и что пропущено с причиной.
 */
export const DocumentBulkInput = z.discriminatedUnion('action', [
  /** Подшить исполненные документы в одно дело. */
  z.object({ action: z.literal('file'), ids: Ids, caseId: Uuid }),
  /** Отправить на ознакомление одним списком адресатов. */
  z.object({ action: z.literal('acknowledge'), ids: Ids, request: AcknowledgmentRequestInput }),
])
export type DocumentBulkInput = z.infer<typeof DocumentBulkInput>

export const DocumentBulkResult = z.object({
  done: z.array(Uuid),
  skipped: z.array(z.object({ id: Uuid, title: z.string(), reason: z.string() })),
})
export type DocumentBulkResult = z.infer<typeof DocumentBulkResult>

/** Реестр выбранных документов в Excel: идентификаторы через запятую. */
export const DocumentRegistryQuery = z.object({
  ids: z
    .string()
    .max(DOCUMENT_BULK_LIMIT * 37)
    .transform((value) => value.split(',').filter(Boolean))
    .pipe(Ids),
})
