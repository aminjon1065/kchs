import type { DocumentRecord, FieldDef } from '@kchs/contracts'
import { formatDate, formatValue } from '@kchs/fields'
import { type KeyValueItem, KeyValueList } from '@kchs/ui'
import type { ReactNode } from 'react'
import { useLocale } from '~/shared/appearance.js'
import { useT } from '~/shared/i18n.js'
import { useRequisiteControls } from './requisites-form.js'

/** Поля, значение которых — ссылка (сотрудник, территория, объект): подпись даёт их контрол. */
const REFERENCE_TYPES = new Set(['territory', 'user', 'unit', 'object_ref', 'reference'])

const empty = (value: unknown) =>
  value === null ||
  value === undefined ||
  value === '' ||
  (Array.isArray(value) && value.length === 0)

/**
 * Реквизиты документа строками «подпись — значение» (ADR-0230): то, что видит тот, кто не
 * правит карточку. Поля типа — по своему определению; точка — координатами моноширинно;
 * ссылочные поля — их же контролом без правки (имя сотрудника, территории, объекта).
 */
export function RequisitesView({ document }: { document: DocumentRecord }) {
  const t = useT()
  const locale = useLocale()
  const renderControl = useRequisiteControls(document.type.cardSchema.fields)
  const day = (value: string) => formatDate(`${value}T12:00:00`, { locale })
  const items: KeyValueItem[] = []
  const add = (key: string, label: string, value: ReactNode | null | undefined) => {
    if (value === null || value === undefined || value === '') return
    items.push({ key, label, value })
  }

  if (document.type.direction === 'incoming') {
    add('correspondent', t('documents.fields.correspondent'), document.correspondent?.name)
    add(
      'external',
      t('documents.fields.externalNumber'),
      document.externalNumber
        ? document.externalDate
          ? t('documents.header.number', {
              number: document.externalNumber,
              date: day(document.externalDate),
            })
          : document.externalNumber
        : null,
    )
    add(
      'received',
      t('documents.fields.receivedDate'),
      document.receivedDate ? day(document.receivedDate) : null,
    )
    add(
      'delivery',
      t('documents.fields.deliveryMethod'),
      document.deliveryMethod ? t(`documents.delivery.${document.deliveryMethod}`) : null,
    )
  }
  add('author', t('documents.fields.author'), document.author?.displayName)
  add('unit', t('documents.fields.unit'), document.unit?.name)
  add('responsible', t('documents.fields.responsible'), document.responsible?.displayName)
  add('signer', t('documents.fields.signer'), document.signer?.displayName)
  add(
    'deadline',
    t('documents.fields.deadline'),
    document.deadline ? (
      <span className={document.overdue ? 'text-danger' : undefined}>{day(document.deadline)}</span>
    ) : null,
  )
  if (document.control !== 'none') {
    add(
      'control',
      t('documents.fields.control'),
      document.controller
        ? `${t(`documents.controls.${document.control}`)} · ${document.controller.displayName}`
        : t(`documents.controls.${document.control}`),
    )
  }
  add('journal', t('documents.fields.journal'), document.registration?.journalName)
  add(
    'case',
    t('documents.fields.case'),
    (document.case ?? document.registrationCase)
      ? `${(document.case ?? document.registrationCase)?.index} · ${(document.case ?? document.registrationCase)?.title}`
      : null,
  )

  for (const field of document.type.cardSchema.fields as FieldDef[]) {
    const value = document.fields[field.key]
    if (empty(value)) continue
    const label = field.label[locale] ?? field.label.ru
    if (REFERENCE_TYPES.has(field.type)) {
      const control = renderControl({
        id: `requisite-${field.key}`,
        field,
        value,
        invalid: false,
        disabled: true,
        onChange: () => undefined,
      })
      if (control) {
        add(`field-${field.key}`, label, control)
        continue
      }
    }
    const shown = formatValue(value, field, { locale })
    add(
      `field-${field.key}`,
      label,
      field.type === 'geometry' ? (
        <span className="font-mono text-xs tabular">{shown}</span>
      ) : (
        shown
      ),
    )
  }

  add(
    'summary',
    t('documents.fields.summary'),
    document.summary ? (
      <span className="whitespace-pre-line leading-5">{document.summary}</span>
    ) : null,
  )

  if (items.length === 0) {
    return <p className="py-3 text-sm text-fg-muted">{t('documents.card.noRequisites')}</p>
  }
  return <KeyValueList layout="rows" items={items} />
}
