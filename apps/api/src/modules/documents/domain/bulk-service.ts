import type { DocumentBulkInput, DocumentBulkResult, DocumentRecord } from '@kchs/contracts'
import { createTranslator } from '@kchs/i18n'
import { authorize } from '~/kernel/access/authorize.js'
import { AUDIT_ACTIONS, audit } from '~/kernel/audit/service.js'
import type { UserCtx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { AppError } from '~/shared/errors.js'
import { writeXlsx } from '~/shared/xlsx.js'
import { DocumentAcknowledgments } from './acknowledgment-service.js'
import { CaseService } from './case-service.js'
import { DocumentService } from './document-service.js'

type Translate = ReturnType<typeof createTranslator>

/**
 * Причина отказа: ошибки домена уже объясняют, что не так (как detail в ответе),
 * а недоступный документ не выдаёт, существует ли он.
 */
function reasonOf(t: Translate, error: unknown): string {
  if (error instanceof AppError) {
    return error.status === 404 ? t('documents.bulk.hidden') : error.message
  }
  return t('errors.internal_error')
}

/** Название для итога — только если документ виден спрашивающему. */
async function titleOf(ctx: UserCtx, id: string): Promise<string> {
  try {
    return (await DocumentService.get(ctx, id)).subject
  } catch {
    return ''
  }
}

/**
 * Массовые действия в списке документов (ADR-0152). Каждый документ — в своей
 * транзакции со своими проверками прав и состояния: отказ по одному не отменяет
 * остальных, а итог говорит, что сделано и что пропущено и почему.
 */
export const DocumentBulk = {
  async run(ctx: UserCtx, input: DocumentBulkInput): Promise<DocumentBulkResult> {
    const t = createTranslator(ctx.locale)
    const done: string[] = []
    const skipped: DocumentBulkResult['skipped'] = []
    for (const id of [...new Set(input.ids)]) {
      try {
        if (input.action === 'file') {
          await db().transaction((tx) => CaseService.fileDocument(tx, ctx, id, input.caseId))
        } else {
          const outcome = await db().transaction((tx) =>
            DocumentAcknowledgments.request(tx, ctx, id, input.request),
          )
          // Все адресаты уже знакомятся или без допуска: документ не изменился
          if (outcome.added === 0) {
            skipped.push({
              id,
              title: await titleOf(ctx, id),
              reason: t('documents.bulk.noRecipients'),
            })
            continue
          }
        }
        done.push(id)
      } catch (error) {
        skipped.push({ id, title: await titleOf(ctx, id), reason: reasonOf(t, error) })
      }
    }
    return { done, skipped }
  },

  /**
   * Реестр выбранных документов в Excel — как опись для передачи или отчёта.
   * Документы, которых спрашивающий не видит, в реестр не попадают.
   */
  async registry(ctx: UserCtx, ids: string[]): Promise<Buffer> {
    const t = createTranslator(ctx.locale)
    const records: DocumentRecord[] = []
    for (const id of [...new Set(ids)]) {
      if (!(await authorize(ctx, 'view', id, { soft: true })).allowed) continue
      records.push(await DocumentService.get(ctx, id))
    }
    // Выгрузка уводит сведения из системы: кто и какие документы выгрузил — в журнал
    await audit(ctx, {
      action: AUDIT_ACTIONS.documentsRegistryExported,
      objectType: 'document',
      severity: 'notice',
      details: { count: records.length, ids: records.map((record) => record.id) },
    })
    const column = (key: string) => t(`documents.bulk.registry.columns.${key}`)
    const header = [
      column('position'),
      column('number'),
      column('date'),
      column('type'),
      column('subject'),
      column('correspondent'),
      column('externalNumber'),
      column('status'),
      column('deadline'),
      column('responsible'),
      column('case'),
    ]
    const rows = records.map((record, index) => [
      String(index + 1),
      record.regNumber ?? '',
      record.regDate ?? '',
      record.type.name[ctx.locale] ?? record.type.name.ru,
      record.subject,
      record.correspondent?.name ?? '',
      [record.externalNumber, record.externalDate]
        .filter(Boolean)
        .join(t('documents.bulk.registry.of')),
      t(`documents.statuses.${record.status}`),
      record.deadline ?? '',
      record.responsible?.displayName ?? '',
      record.case ? `${record.case.index} ${record.case.title}` : '',
    ])
    return writeXlsx([
      {
        name: t('documents.bulk.registry.sheet'),
        rows: [header, ...rows],
        header: true,
        widths: [6, 16, 12, 22, 48, 28, 20, 18, 12, 26, 28],
      },
    ])
  },
}
