import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import { visibleObjectsSql } from '~/kernel/access/authorize.js'
import { Acknowledgments } from '~/kernel/acknowledgments/index.js'
import { db } from '~/shared/db/client.js'
import { acknowledgmentRequests, documents, objects } from '~/shared/db/schema/index.js'
import { CaseService } from '../../case-service.js'
import { DocumentService } from '../../document-service.js'
import { html, type SafeHtml } from '../html.js'
import type { PrintFormDefinition, PrintSubject } from '../registry.js'
import { dateOnly, dateTime, fileNameOf, footerOf, person } from './common.js'

/** Опись показывает не больше строк — дело номенклатуры обычно меньше. */
const MAX_ROWS = 1000

const text = (value: unknown) =>
  value === null || value === undefined || value === '' ? '' : String(value)

/**
 * Лист ознакомления (08-documents.md §10): кто ознакомлен и когда, за кого
 * отметил заместитель, подтверждено ли кодом, кто ещё не ознакомился —
 * по учёту ознакомления ядра (ADR-0084).
 */
export const acknowledgmentSheet: PrintFormDefinition = {
  key: 'acknowledgment_sheet',
  labelKey: 'documents.print.forms.acknowledgment_sheet',
  subjectType: 'document',
  typeListed: false,
  unavailable: async (subject: PrintSubject) => {
    const [request] = await db()
      .select({ id: acknowledgmentRequests.id })
      .from(acknowledgmentRequests)
      .where(eq(acknowledgmentRequests.objectId, subject.id))
      .limit(1)
    return request ? null : 'documents.print.reasons.noAcknowledgments'
  },
  build: async (pc, subject) => {
    const doc = await DocumentService.get(pc.ctx, subject.id)
    const list = await Acknowledgments.list(pc.ctx, subject.id)
    const { t } = pc
    const title = t('documents.print.sheets.acknowledgmentTitle')
    const typeName = doc.type.name[pc.locale] ?? doc.type.name.ru
    const number = doc.regNumber
      ? t('documents.print.sheets.numbered', {
          number: doc.regNumber,
          date: dateOnly(doc.regDate, pc),
        })
      : t('documents.print.sheets.draft')
    const entries = list.items.filter((item) => item.state !== 'cancelled')
    const rows = entries.map((item, index) => {
      const marked =
        item.actor && item.actor.id !== item.user.id
          ? t('documents.print.sheets.markedBy', { name: person(item.actor) })
          : ''
      return html`<tr>
        <td class="num">${index + 1}</td>
        <td>${person(item.user)}</td>
        <td>${item.acknowledgedAt ? dateTime(item.acknowledgedAt, pc) : t('documents.print.sheets.notYet')}</td>
        <td>${item.acknowledgedAt ? (item.secondFactor ? t('documents.print.sheets.mfaYes') : t('documents.print.sheets.mfaNo')) : ''}</td>
        <td>${marked}</td>
        <td>${item.dueAt ? dateTime(item.dueAt, pc) : ''}</td>
      </tr>`
    })
    const body: SafeHtml = html`
      <div class="org">${pc.org}</div>
      <h1>${title}</h1>
      <p class="subtitle">${typeName} · ${number}</p>
      <p><strong>${t('documents.fields.subject')}:</strong> ${doc.subject || '—'}</p>
      <table class="grid">
        <thead><tr>
          <th class="num">№</th>
          <th>${t('documents.print.sheets.employee')}</th>
          <th>${t('documents.print.sheets.acknowledgedAt')}</th>
          <th>${t('documents.print.sheets.mfa')}</th>
          <th>${t('documents.print.sheets.marked')}</th>
          <th>${t('documents.print.sheets.due')}</th>
        </tr></thead>
        <tbody>${
          rows.length > 0
            ? rows
            : html`<tr><td colspan="6" class="muted">${t('documents.print.sheets.noAcknowledgments')}</td></tr>`
        }</tbody>
      </table>
      <p>${t('documents.print.sheets.acknowledgmentTotal', {
        acknowledged: list.summary.acknowledged,
        total: list.summary.total,
      })}</p>
    `
    return {
      kind: 'html',
      title,
      body,
      footer: footerOf(pc),
      fileName: fileNameOf(title, doc.regNumber ?? doc.subject),
    }
  },
}

/**
 * Опись дела (08-documents.md §12): документы дела номенклатуры по порядку
 * подшивки — номер и дата регистрации, заголовок, листы, отметки; итог и
 * подписи составителя. Строки — документы, которые видит печатающий.
 */
export const caseInventory: PrintFormDefinition = {
  key: 'case_inventory',
  labelKey: 'documents.print.forms.case_inventory',
  subjectType: 'case',
  build: async (pc, subject) => {
    const record = await CaseService.get(pc.ctx, subject.id)
    const rows = await db()
      .select({
        regNumber: documents.regNumber,
        regDate: documents.regDate,
        subject: documents.subject,
        fields: documents.fields,
        filesDestroyedAt: documents.filesDestroyedAt,
      })
      .from(documents)
      .innerJoin(objects, eq(objects.id, documents.id))
      .where(
        and(
          eq(documents.caseId, subject.id),
          isNull(objects.deletedAt),
          visibleObjectsSql(pc.ctx, 'document'),
        ),
      )
      .orderBy(
        asc(documents.filedAt),
        asc(documents.regDate),
        sql`${documents.regNumber} NULLS LAST`,
      )
      .limit(MAX_ROWS + 1)
    const shown = rows.slice(0, MAX_ROWS)
    const { t } = pc
    const title = t('documents.print.inventory.title')
    const retention =
      record.retentionYears === null
        ? t('documents.print.inventory.permanent')
        : t('documents.print.inventory.years', { count: record.retentionYears })
    const lines = shown.map(
      (row, index) => html`<tr>
        <td class="num">${index + 1}</td>
        <td class="mono">${row.regNumber ?? '—'}</td>
        <td>${dateOnly(row.regDate, pc)}</td>
        <td>${row.subject || '—'}</td>
        <td class="num">${text(row.fields.pages)}</td>
        <td>${row.filesDestroyedAt ? t('documents.print.inventory.destroyed') : ''}</td>
      </tr>`,
    )
    const body: SafeHtml = html`
      <div class="org">${pc.org}</div>
      <h1>${title}</h1>
      <p class="subtitle">${t('documents.print.inventory.case', {
        index: record.index,
        title: record.title,
        year: record.year,
      })}</p>
      <p>${t('documents.print.inventory.retention', { retention })}${
        record.retentionNote ? ` · ${record.retentionNote}` : ''
      }${record.unit ? ` · ${record.unit.name}` : ''}</p>
      <table class="grid">
        <thead><tr>
          <th class="num">№</th>
          <th>${t('documents.fields.regNumber')}</th>
          <th>${t('documents.fields.regDate')}</th>
          <th>${t('documents.print.inventory.heading')}</th>
          <th class="num">${t('documents.print.dispatch.pages')}</th>
          <th>${t('documents.print.inventory.note')}</th>
        </tr></thead>
        <tbody>${
          lines.length > 0
            ? lines
            : html`<tr><td colspan="6" class="muted">${t('documents.print.inventory.empty')}</td></tr>`
        }</tbody>
      </table>
      <p>${t('documents.print.inventory.total', { count: shown.length })}${
        rows.length > MAX_ROWS
          ? ` ${t('documents.print.inventory.truncated', { max: MAX_ROWS })}`
          : ''
      }</p>
      <div class="signatures">
        <div class="signature">${t('documents.print.inventory.compiled')}</div>
        <div class="signature">${t('documents.print.inventory.approved')}</div>
      </div>
    `
    return {
      kind: 'html',
      title,
      body,
      footer: footerOf(pc),
      fileName: fileNameOf(title, record.index, String(record.year)),
    }
  },
}
