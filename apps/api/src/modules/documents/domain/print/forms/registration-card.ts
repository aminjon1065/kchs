import type { DocumentRecord } from '@kchs/contracts'
import { formatValue } from '@kchs/fields'
import { DocumentService } from '../../document-service.js'
import { html, multiline, type SafeHtml } from '../html.js'
import type { PrintContext, PrintFormDefinition } from '../registry.js'
import { dateOnly, dateTime, fileNameOf, footerOf, person } from './common.js'

function row(label: string, value: SafeHtml | string | null | undefined): SafeHtml {
  const empty = value === null || value === undefined || value === ''
  return html`<tr><th>${label}</th><td>${empty ? '—' : value}</td></tr>`
}

function body(pc: PrintContext, doc: DocumentRecord): SafeHtml {
  const { t } = pc
  const typeName = doc.type.name[pc.locale] ?? doc.type.name.ru
  const incoming = doc.type.direction === 'incoming'
  const external = [doc.externalNumber, dateOnly(doc.externalDate, pc)].filter(Boolean).join(' / ')
  const fields = doc.type.cardSchema.fields
    .filter((field) => doc.fields[field.key] !== undefined && doc.fields[field.key] !== null)
    .map((field) =>
      row(
        field.label[pc.locale] ?? field.label.ru,
        formatValue(doc.fields[field.key], field, { locale: pc.locale, timezone: pc.timezone }),
      ),
    )
  const registration = doc.registration
  return html`
    <div class="org">${pc.org}</div>
    <h1>${t('documents.print.card.title')}</h1>
    <p class="subtitle">${typeName}</p>
    <table class="card">
      ${row(t('documents.print.card.number'), registration?.number ?? doc.regNumber)}
      ${row(t('documents.print.card.date'), dateOnly(doc.regDate, pc))}
      ${row(t('documents.fields.journal'), registration?.journalName)}
      ${
        incoming
          ? [
              row(t('documents.fields.correspondent'), doc.correspondent?.name),
              row(t('documents.print.card.external'), external),
              row(t('documents.fields.receivedDate'), dateOnly(doc.receivedDate, pc)),
              row(
                t('documents.fields.deliveryMethod'),
                doc.deliveryMethod ? t(`documents.delivery.${doc.deliveryMethod}`) : null,
              ),
            ]
          : row(t('documents.fields.correspondent'), doc.correspondent?.name)
      }
      ${row(t('documents.fields.subject'), doc.subject)}
      ${row(t('documents.fields.summary'), doc.summary ? multiline(doc.summary) : null)}
      ${fields}
      ${row(t('documents.fields.author'), person(doc.author))}
      ${row(t('documents.fields.responsible'), person(doc.responsible))}
      ${row(t('documents.fields.signer'), person(doc.signer))}
      ${row(t('documents.fields.controller'), person(doc.controller))}
      ${row(t('documents.fields.deadline'), dateOnly(doc.deadline, pc))}
      ${row(t('documents.fields.control'), t(`documents.controls.${doc.control}`))}
      ${row(t('documents.fields.confidentiality'), t(`access.confidentiality.${doc.confidentiality}`))}
      ${row(t('documents.fields.status'), t(`documents.statuses.${doc.status}`))}
      ${row(
        t('documents.card.registeredBy'),
        registration
          ? [person(registration.registeredBy), dateTime(registration.registeredAt, pc)]
              .filter(Boolean)
              .join(', ')
          : null,
      )}
    </table>
    <p class="section">${t('documents.print.card.resolution')}</p>
    <table class="card"><tr><td>&nbsp;</td></tr><tr><td>&nbsp;</td></tr><tr><td>&nbsp;</td></tr></table>
    <p class="section">${t('documents.print.card.execution')}</p>
    <table class="card"><tr><td>&nbsp;</td></tr><tr><td>&nbsp;</td></tr></table>
  `
}

/**
 * Регистрационно-контрольная карточка (08-documents.md §5): реквизиты
 * регистрации, корреспондент, содержание, участники, срок и контроль; поля
 * для резолюции и отметки об исполнении — от руки.
 */
export const registrationCard: PrintFormDefinition = {
  key: 'registration_card',
  labelKey: 'documents.print.forms.registration_card',
  subjectType: 'document',
  build: async (pc, subject) => {
    const doc = await DocumentService.get(pc.ctx, subject.id)
    const title = pc.t('documents.print.card.title')
    return {
      kind: 'html',
      title,
      body: body(pc, doc),
      footer: footerOf(pc),
      fileName: fileNameOf(title, doc.regNumber ?? doc.subject),
    }
  },
}
