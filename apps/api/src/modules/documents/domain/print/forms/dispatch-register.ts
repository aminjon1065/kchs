import { and, asc, eq, sql } from 'drizzle-orm'
import { visibleObjectsSql } from '~/kernel/access/authorize.js'
import { db } from '~/shared/db/client.js'
import { documents, journals, objects, registrations } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { CorrespondentService } from '../../correspondent-service.js'
import { html } from '../html.js'
import type { PrintFormDefinition } from '../registry.js'
import { dateOnly, fileNameOf, footerOf } from './common.js'

/** Строк в бумажном реестре не больше: дальше — выгрузка системного датасета. */
const MAX_ROWS = 2000

function text(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
}

/**
 * Реестр отправки (08-documents.md §5): документы журнала, зарегистрированные
 * за период, — адресат, краткое содержание, листы и графа отметки об отправке.
 * Строки — только те, что видит печатающий (права и допуск), аннулированные —
 * нет.
 */
export const dispatchRegister: PrintFormDefinition = {
  key: 'dispatch_register',
  labelKey: 'documents.print.forms.dispatch_register',
  subjectType: 'journal',
  params: ['period'],
  build: async (pc, subject, params) => {
    const period = params.period
    if (!period)
      throw errors.validation('Нужен период реестра', [
        { path: 'params.period', message: 'required' },
      ])
    const [journal] = await db()
      .select({ name: journals.name })
      .from(journals)
      .where(eq(journals.id, subject.id))
      .limit(1)
    const rows = await db()
      .select({
        regNumber: documents.regNumber,
        regDate: documents.regDate,
        subject: documents.subject,
        fields: documents.fields,
        correspondentId: documents.correspondentId,
        sequence: registrations.sequence,
      })
      .from(documents)
      .innerJoin(objects, eq(objects.id, documents.id))
      .innerJoin(
        registrations,
        and(
          eq(registrations.documentId, documents.id),
          eq(registrations.journalId, documents.journalId),
        ),
      )
      .where(
        and(
          eq(documents.journalId, subject.id),
          sql`${documents.regDate} BETWEEN ${period.from} AND ${period.to}`,
          sql`${documents.status} <> 'cancelled'`,
          sql`${objects.deletedAt} IS NULL`,
          visibleObjectsSql(pc.ctx, 'document'),
        ),
      )
      .orderBy(asc(documents.regDate), asc(registrations.sequence))
      .limit(MAX_ROWS + 1)
    const shown = rows.slice(0, MAX_ROWS)
    const names = await CorrespondentService.names(db(), [
      ...new Set(shown.map((row) => row.correspondentId).filter((id): id is string => !!id)),
    ])
    const { t } = pc
    const title = t('documents.print.dispatch.title')
    const periodText = t('documents.print.dispatch.period', {
      from: dateOnly(period.from, pc),
      to: dateOnly(period.to, pc),
    })
    const lines = shown.map((row, index) => {
      const addressee =
        text(row.fields.addressee) ||
        (row.correspondentId ? (names.get(row.correspondentId)?.name ?? '') : '')
      return html`<tr>
        <td class="num">${index + 1}</td>
        <td class="mono">${row.regNumber}</td>
        <td>${dateOnly(row.regDate, pc)}</td>
        <td>${addressee || '—'}</td>
        <td>${row.subject || '—'}</td>
        <td class="num">${text(row.fields.pages)}</td>
        <td></td>
      </tr>`
    })
    const body = html`
      <div class="org">${pc.org}</div>
      <h1>${title}</h1>
      <p class="subtitle">${journal?.name ?? subject.title} · ${periodText}</p>
      <table class="grid">
        <thead><tr>
          <th class="num">${t('documents.print.dispatch.index')}</th>
          <th>${t('documents.fields.regNumber')}</th>
          <th>${t('documents.fields.regDate')}</th>
          <th>${t('documents.print.dispatch.addressee')}</th>
          <th>${t('documents.fields.subject')}</th>
          <th class="num">${t('documents.print.dispatch.pages')}</th>
          <th>${t('documents.print.dispatch.mark')}</th>
        </tr></thead>
        <tbody>${
          lines.length > 0
            ? lines
            : html`<tr><td colspan="7" class="muted">${t('documents.print.dispatch.empty')}</td></tr>`
        }</tbody>
      </table>
      <p>${t('documents.print.dispatch.total', { count: shown.length })}${
        rows.length > MAX_ROWS
          ? ` ${t('documents.print.dispatch.truncated', { max: MAX_ROWS })}`
          : ''
      }</p>
      <div class="signatures">
        <div class="signature">${t('documents.print.dispatch.handedOver')}</div>
        <div class="signature">${t('documents.print.dispatch.accepted')}</div>
      </div>
    `
    return {
      kind: 'html',
      title,
      body,
      orientation: 'landscape',
      footer: footerOf(pc),
      fileName: fileNameOf(title, journal?.name, `${period.from}—${period.to}`),
    }
  },
}
