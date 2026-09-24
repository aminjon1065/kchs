import {
  CONFIDENTIALITY_LEVELS,
  type Confidentiality,
  type CorrespondentRef,
  DELIVERY_METHODS,
  type DeliveryMethod,
  DOCUMENT_CONTROLS,
  type DocumentControl,
  type DocumentRecord,
  type DocumentTypeBrief,
  type DocumentUpdateInput,
  withinClearance,
} from '@kchs/contracts'
import {
  Field,
  Input,
  SchemaForm,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { useId } from 'react'
import { useT } from '~/app/i18n.js'
import { useFieldControls } from '~/features/data/field-controls.js'
import { type PickedUser, UserPicker } from '~/features/tasks/user-picker.js'
import { meQuery } from '~/shared/api/queries.js'
import { CorrespondentPicker } from '../correspondent-picker.js'

/** Реквизиты карточки в форме: люди и корреспондент — с подписями для показа. */
export interface CardValue {
  subject: string
  summary: string
  correspondent: CorrespondentRef | null
  externalNumber: string
  externalDate: string
  receivedDate: string
  deliveryMethod: DeliveryMethod | null
  responsible: PickedUser | null
  signer: PickedUser | null
  controller: PickedUser | null
  deadline: string
  control: DocumentControl
  confidentiality: Confidentiality
  fields: Record<string, unknown>
}

const person = (ref: DocumentRecord['responsible']): PickedUser | null =>
  ref
    ? {
        id: ref.id,
        title: ref.displayName,
        subtitle: ref.position ?? ref.unitName ?? null,
        avatarUrl: ref.avatarUrl,
      }
    : null

export function cardValueOf(doc: DocumentRecord): CardValue {
  return {
    subject: doc.subject,
    summary: doc.summary ?? '',
    correspondent: doc.correspondent,
    externalNumber: doc.externalNumber ?? '',
    externalDate: doc.externalDate ?? '',
    receivedDate: doc.receivedDate ?? '',
    deliveryMethod: doc.deliveryMethod,
    responsible: person(doc.responsible),
    signer: person(doc.signer),
    controller: person(doc.controller),
    deadline: doc.deadline ?? '',
    control: doc.control,
    confidentiality: doc.confidentiality,
    fields: doc.fields,
  }
}

export function emptyCardValue(confidentiality: Confidentiality): CardValue {
  return {
    subject: '',
    summary: '',
    correspondent: null,
    externalNumber: '',
    externalDate: '',
    receivedDate: '',
    deliveryMethod: null,
    responsible: null,
    signer: null,
    controller: null,
    deadline: '',
    control: 'none',
    confidentiality,
    fields: {},
  }
}

const orNull = (value: string) => (value.trim() === '' ? null : value.trim())

/** Коды ошибок реквизитов от API (`errors[].message`), у которых есть свой текст. */
const ERROR_CODES = new Set([
  'required',
  'not_allowed',
  'above_clearance',
  'correspondent',
  'territory',
  'unit',
])

/** Реквизиты для API: пустые строки — «не задано». */
export function cardPayload(value: CardValue): DocumentUpdateInput {
  return {
    subject: value.subject.trim(),
    summary: orNull(value.summary),
    correspondentId: value.correspondent?.id ?? null,
    externalNumber: orNull(value.externalNumber),
    externalDate: orNull(value.externalDate),
    receivedDate: orNull(value.receivedDate),
    deliveryMethod: value.deliveryMethod,
    responsibleId: value.responsible?.id ?? null,
    signerId: value.signer?.id ?? null,
    deadline: orNull(value.deadline),
    control: value.control,
    controllerId: value.controller?.id ?? null,
    confidentiality: value.confidentiality,
    fields: value.fields,
  }
}

/**
 * Карточка документа (08-documents.md §2, 03-screens.md §12): реквизиты
 * направления типа и поля карточки типа (SchemaForm; сотрудники,
 * подразделения, территории, объекты и справочники — своими контролами,
 * ADR-0129). Для входящего — корреспондент, исходящие реквизиты отправителя,
 * дата поступления, способ доставки. Гриф — из допустимых типом и не строже
 * допуска автора правки.
 */
export function RequisitesForm({
  type,
  value,
  onChange,
  errors = {},
  readOnly = false,
  canCreateCorrespondent = false,
}: {
  type: DocumentTypeBrief
  value: CardValue
  onChange: (value: CardValue) => void
  errors?: Record<string, string>
  readOnly?: boolean
  canCreateCorrespondent?: boolean
}) {
  const t = useT()
  const formId = useId()
  const renderControl = useFieldControls(type.cardSchema.fields)
  const { data: me } = useQuery(meQuery())
  const clearance = me?.clearance ?? 'internal'
  const set = (patch: Partial<CardValue>) => onChange({ ...value, ...patch })
  const incoming = type.direction === 'incoming'
  const idFor = (key: string) => `${formId}-${key}`
  const grifOptions = CONFIDENTIALITY_LEVELS.filter(
    (level) =>
      type.confidentialityAllowed.includes(level) &&
      (withinClearance(level, clearance) || level === value.confidentiality),
  )
  const error = (key: string) => {
    const code = errors[key]
    if (!code) return undefined
    return t(ERROR_CODES.has(code) ? `documents.errors.${code}` : 'documents.errors.invalid')
  }
  const fieldErrors = Object.fromEntries(
    Object.entries(errors)
      .filter(([key]) => key.startsWith('fields.'))
      .map(([key, message]) => [key.slice('fields.'.length), message]),
  )

  return (
    <div className="flex flex-col gap-4">
      <Field
        label={t('documents.fields.subject')}
        htmlFor={idFor('subject')}
        required
        error={error('subject')}
      >
        <Textarea
          id={idFor('subject')}
          data-field-key="subject"
          value={value.subject}
          rows={2}
          maxLength={1000}
          disabled={readOnly}
          onChange={(event) => set({ subject: event.target.value })}
        />
      </Field>

      {incoming || type.direction === 'outgoing' ? (
        <Field
          label={t('documents.fields.correspondent')}
          required={incoming}
          error={error('correspondentId')}
        >
          <CorrespondentPicker
            value={value.correspondent}
            onChange={(correspondent) => set({ correspondent })}
            label={t('documents.fields.correspondent')}
            canCreate={canCreateCorrespondent}
            disabled={readOnly}
            invalid={Boolean(errors.correspondentId)}
          />
        </Field>
      ) : null}

      {incoming ? (
        <div className="grid gap-4 md:grid-cols-2">
          <Field label={t('documents.fields.externalNumber')} htmlFor={idFor('externalNumber')}>
            <Input
              id={idFor('externalNumber')}
              data-field-key="externalNumber"
              value={value.externalNumber}
              maxLength={120}
              disabled={readOnly}
              onChange={(event) => set({ externalNumber: event.target.value })}
            />
          </Field>
          <Field label={t('documents.fields.externalDate')} htmlFor={idFor('externalDate')}>
            <Input
              id={idFor('externalDate')}
              data-field-key="externalDate"
              type="date"
              value={value.externalDate}
              disabled={readOnly}
              onChange={(event) => set({ externalDate: event.target.value })}
            />
          </Field>
          <Field
            label={t('documents.fields.receivedDate')}
            htmlFor={idFor('receivedDate')}
            required
            error={error('receivedDate')}
          >
            <Input
              id={idFor('receivedDate')}
              data-field-key="receivedDate"
              type="date"
              value={value.receivedDate}
              disabled={readOnly}
              onChange={(event) => set({ receivedDate: event.target.value })}
            />
          </Field>
          <Field label={t('documents.fields.deliveryMethod')}>
            <Select
              value={value.deliveryMethod ?? ''}
              onValueChange={(next) =>
                set({ deliveryMethod: (next || null) as DeliveryMethod | null })
              }
              disabled={readOnly}
            >
              <SelectTrigger aria-label={t('documents.fields.deliveryMethod')}>
                <SelectValue placeholder={t('documents.placeholders.choose')} />
              </SelectTrigger>
              <SelectContent>
                {DELIVERY_METHODS.map((method) => (
                  <SelectItem key={method} value={method}>
                    {t(`documents.delivery.${method}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>
      ) : null}

      <Field label={t('documents.fields.summary')} htmlFor={idFor('summary')}>
        <Textarea
          id={idFor('summary')}
          data-field-key="summary"
          value={value.summary}
          rows={3}
          maxLength={20_000}
          disabled={readOnly}
          onChange={(event) => set({ summary: event.target.value })}
        />
      </Field>

      <div className="grid gap-4 md:grid-cols-2">
        <Field label={t('documents.fields.responsible')}>
          {readOnly ? (
            <ReadOnlyPerson user={value.responsible} />
          ) : (
            <UserPicker
              value={value.responsible}
              onChange={(responsible) => set({ responsible })}
              label={t('documents.fields.responsible')}
            />
          )}
        </Field>
        <Field label={t('documents.fields.signer')}>
          {readOnly ? (
            <ReadOnlyPerson user={value.signer} />
          ) : (
            <UserPicker
              value={value.signer}
              onChange={(signer) => set({ signer })}
              label={t('documents.fields.signer')}
            />
          )}
        </Field>
        <Field label={t('documents.fields.deadline')} htmlFor={idFor('deadline')}>
          <Input
            id={idFor('deadline')}
            data-field-key="deadline"
            type="date"
            value={value.deadline}
            disabled={readOnly}
            onChange={(event) => set({ deadline: event.target.value })}
          />
        </Field>
        <Field label={t('documents.fields.control')}>
          <Select
            value={value.control}
            onValueChange={(next) => set({ control: next as DocumentControl })}
            disabled={readOnly}
          >
            <SelectTrigger aria-label={t('documents.fields.control')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DOCUMENT_CONTROLS.map((control) => (
                <SelectItem key={control} value={control}>
                  {t(`documents.controls.${control}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label={t('documents.fields.controller')}>
          {readOnly ? (
            <ReadOnlyPerson user={value.controller} />
          ) : (
            <UserPicker
              value={value.controller}
              onChange={(controller) => set({ controller })}
              label={t('documents.fields.controller')}
            />
          )}
        </Field>
        <Field
          label={t('access.confidentiality.label')}
          error={error('confidentiality')}
          hint={t('documents.hints.confidentiality')}
        >
          <Select
            value={value.confidentiality}
            onValueChange={(next) => set({ confidentiality: next as Confidentiality })}
            disabled={readOnly}
          >
            <SelectTrigger aria-label={t('access.confidentiality.label')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {grifOptions.map((level) => (
                <SelectItem key={level} value={level}>
                  {t(`access.confidentiality.${level}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>

      {type.cardSchema.fields.length > 0 ? (
        <section className="flex flex-col gap-3 border-t border-line pt-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
            {t('documents.card.typeFields')}
          </h3>
          <SchemaForm
            schema={{ fields: type.cardSchema.fields }}
            values={value.fields}
            onChange={(fields) => set({ fields })}
            renderControl={renderControl}
            serverErrors={fieldErrors}
            readOnly={readOnly}
          />
        </section>
      ) : null}
    </div>
  )
}

function ReadOnlyPerson({ user }: { user: PickedUser | null }) {
  return (
    <span className="flex h-9 items-center text-sm text-fg">
      {user?.title ?? <span className="text-fg-muted">—</span>}
    </span>
  )
}
