import type {
  DocumentExtractedField,
  DocumentExtraction,
  DocumentRecord,
  FieldDef,
} from '@kchs/contracts'
import { localizedText } from '@kchs/i18n'
import { Badge, Button, Callout, Card, cn, Spinner, useToast } from '@kchs/ui'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Check, Sparkles } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { ApiError, http } from '~/shared/api/client.js'
import { confidenceTone, documentAssistQuery } from '../assist/queries.js'
import type { CardValue } from '../card/requisites-form.js'

/**
 * Слот помощника регистрации (08-documents.md §5; вторая волна P3-E02 S02):
 * OCR скана → автозаполнение полей ИИ с подсветкой уверенности (подтверждение
 * человеком обязательно), клик по полю — подсветка зоны на скане. Экран
 * регистрации передаёт сюда черновик, скан, значения карточки и поле в фокусе;
 * вторая волна пишет только этот файл.
 */
export interface RegistrationAssistProps {
  /** Черновик создаётся с первым сканом или сохранением. */
  documentId: string | null
  /** Основной файл текущей версии (скан). */
  scanFileId: string | null
  value: CardValue
  onChange: (value: CardValue) => void
  /** Ключ реквизита или поля карточки в фокусе (`subject`, `fields.pages`). */
  activeField: string | null
}

/** Реквизиты карточки, которые заполняет помощник, — строкой формы. */
const TEXT_KEYS = ['subject', 'summary', 'externalNumber', 'externalDate', 'receivedDate'] as const
type TextKey = (typeof TEXT_KEYS)[number]

const NUMERIC = new Set(['integer', 'number', 'decimal', 'money'])

/** Значение предложения в карточку: числа полей типа — числом. */
export function applySuggestion(
  value: CardValue,
  field: Pick<DocumentExtractedField, 'key' | 'value'>,
  fieldTypes: ReadonlyMap<string, string>,
): CardValue {
  if ((TEXT_KEYS as readonly string[]).includes(field.key)) {
    return { ...value, [field.key as TextKey]: field.value }
  }
  if (field.key.startsWith('fields.')) {
    const key = field.key.slice('fields.'.length)
    const type = fieldTypes.get(key)
    const numeric = type && NUMERIC.has(type) ? Number(field.value.replace(',', '.')) : Number.NaN
    return {
      ...value,
      fields: { ...value.fields, [key]: Number.isFinite(numeric) ? numeric : field.value },
    }
  }
  return value
}

/** Текущее значение карточки для ключа предложения — показать «сейчас: …». */
function currentOf(value: CardValue, key: string): string {
  if ((TEXT_KEYS as readonly string[]).includes(key)) return value[key as TextKey]
  if (key.startsWith('fields.')) {
    const current = value.fields[key.slice('fields.'.length)]
    return current === undefined || current === null ? '' : String(current)
  }
  return ''
}

/**
 * Помощник регистрации (ADR-0088): «Заполнить по скану» — модель предлагает
 * реквизиты с уверенностью и цитатой, отправитель сверяется со справочником.
 * Ничего не попадает в карточку без нажатия «Принять»; поле в фокусе
 * подсвечивает своё предложение. Без ИИ на установке панели нет.
 */
export function RegistrationAssist({
  documentId,
  scanFileId,
  value,
  onChange,
  activeField,
}: RegistrationAssistProps): ReactNode {
  const t = useT()
  const toast = useToast()
  const locale = useAppearance((s) => s.locale)
  const [result, setResult] = useState<DocumentExtraction | null>(null)
  const [accepted, setAccepted] = useState<ReadonlySet<string>>(new Set())
  const enabled = Boolean(documentId && scanFileId)
  const status = useQuery({ ...documentAssistQuery(documentId ?? ''), enabled })
  // Схема полей типа — своим ключом: кэш карточки после регистрации не должен остаться черновиком
  const doc = useQuery({
    queryKey: ['object', documentId ?? '', 'document-assist-card'],
    queryFn: () => http.get<DocumentRecord>(`/documents/${documentId}`),
    enabled,
  })
  const extract = useMutation({
    mutationFn: () => http.post<DocumentExtraction>(`/documents/${documentId}/assist/extract`),
    onSuccess: (data) => {
      setResult(data)
      setAccepted(new Set())
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t('errors.unknown')),
  })

  if (!enabled || !status.data || status.data.blocker === 'ai_disabled') return null
  const blocker = status.data.blocker
  if (blocker === 'text_pending') {
    return (
      <Callout tone="info">
        <span className="flex items-center gap-2">
          <Spinner className="size-3.5" label={t('documentAssist.registration.pending')} />
          {t('documentAssist.registration.pending')}
        </span>
      </Callout>
    )
  }
  if (blocker) {
    return <Callout tone="info">{t(`documentAssist.blockers.${blocker}`)}</Callout>
  }

  const schemaFields: FieldDef[] = doc.data?.type.cardSchema.fields ?? []
  const fieldTypes = new Map(schemaFields.map((field) => [field.key, field.type]))
  const labelOf = (key: string) => {
    if (key.startsWith('fields.')) {
      const field = schemaFields.find((item) => `fields.${item.key}` === key)
      return field ? localizedText(field.label, locale) : key
    }
    return t(`documents.fields.${key}`)
  }
  const accept = (field: DocumentExtractedField, current: CardValue = value) => {
    const next = applySuggestion(current, field, fieldTypes)
    setAccepted((previous) => new Set(previous).add(field.key))
    return next
  }
  const confident = result?.fields.filter(
    (field) => field.confidence >= 0.8 && !accepted.has(field.key),
  )
  const correspondent = result?.correspondent

  return (
    <Card
      title={t('documentAssist.registration.title')}
      action={
        <Button
          size="sm"
          variant={result ? 'secondary' : 'primary'}
          icon={<Sparkles className="size-3.5" />}
          loading={extract.isPending}
          onClick={() => extract.mutate()}
        >
          {result ? t('documentAssist.registration.again') : t('documentAssist.registration.fill')}
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-xs text-fg-muted">{t('documentAssist.registration.hint')}</p>
        {result && result.fields.length === 0 && !correspondent ? (
          <p className="text-sm text-fg-secondary">{t('documentAssist.registration.nothing')}</p>
        ) : null}
        {result ? (
          <ul
            aria-label={t('documentAssist.registration.suggestions')}
            className="flex flex-col gap-2"
          >
            {correspondent ? (
              <li
                className={cn(
                  'rounded-md border border-line bg-surface p-2.5',
                  activeField === 'correspondent' && 'ring-2 ring-accent/40',
                )}
              >
                <SuggestionHead
                  label={t('documents.fields.correspondent')}
                  confidence={correspondent.confidence}
                />
                <p className="text-sm text-fg">{correspondent.match?.name ?? correspondent.name}</p>
                <p className="text-xs text-fg-muted">
                  {correspondent.match
                    ? t('documentAssist.registration.matched')
                    : t('documentAssist.registration.unmatched')}
                </p>
                {correspondent.match ? (
                  <AcceptButton
                    done={
                      accepted.has('correspondent') ||
                      value.correspondent?.id === correspondent.match.id
                    }
                    label={t('documents.fields.correspondent')}
                    onClick={() => {
                      const match = correspondent.match
                      if (!match) return
                      onChange({ ...value, correspondent: match })
                      setAccepted((previous) => new Set(previous).add('correspondent'))
                    }}
                  />
                ) : null}
              </li>
            ) : null}
            {result.fields.map((field) => {
              const current = currentOf(value, field.key)
              const done = accepted.has(field.key) || current === field.value
              return (
                <li
                  key={field.key}
                  className={cn(
                    'rounded-md border border-line bg-surface p-2.5',
                    activeField === field.key && 'ring-2 ring-accent/40',
                  )}
                >
                  <SuggestionHead label={labelOf(field.key)} confidence={field.confidence} />
                  <p className="whitespace-pre-wrap text-sm text-fg">{field.value}</p>
                  {field.quote ? (
                    <p className="mt-0.5 text-xs text-fg-muted">
                      {t('documentAssist.registration.quote', { quote: field.quote })}
                    </p>
                  ) : null}
                  {current && current !== field.value ? (
                    <p className="mt-0.5 text-xs text-fg-muted">
                      {t('documentAssist.registration.current', { value: current })}
                    </p>
                  ) : null}
                  <AcceptButton
                    done={done}
                    label={labelOf(field.key)}
                    onClick={() => onChange(accept(field))}
                  />
                </li>
              )
            })}
          </ul>
        ) : null}
        {confident && confident.length > 1 ? (
          <div>
            <Button
              size="sm"
              variant="secondary"
              icon={<Check className="size-3.5" />}
              onClick={() =>
                onChange(confident.reduce((next, field) => accept(field, next), value))
              }
            >
              {t('documentAssist.registration.acceptConfident', { count: confident.length })}
            </Button>
          </div>
        ) : null}
        {result?.truncated ? (
          <p className="text-xs text-fg-muted">{t('documentAssist.truncated')}</p>
        ) : null}
      </div>
    </Card>
  )
}

function SuggestionHead({ label, confidence }: { label: string; confidence: number }) {
  const t = useT()
  const tone = confidenceTone(confidence)
  return (
    <div className="mb-1 flex items-center justify-between gap-2">
      <span className="text-xs font-medium text-fg-secondary">{label}</span>
      <Badge tone={tone} size="sm">
        {t(`documentAssist.confidence.${tone}`, { percent: Math.round(confidence * 100) })}
      </Badge>
    </div>
  )
}

function AcceptButton({
  done,
  label,
  onClick,
}: {
  done: boolean
  label: string
  onClick: () => void
}) {
  const t = useT()
  if (done) {
    return (
      <p className="mt-1.5 flex items-center gap-1 text-xs text-success">
        <Check className="size-3.5" aria-hidden />
        {t('documentAssist.registration.accepted')}
      </p>
    )
  }
  return (
    <Button
      size="sm"
      variant="ghost"
      className="mt-1"
      aria-label={t('documentAssist.registration.acceptNamed', { field: label })}
      onClick={onClick}
    >
      {t('documentAssist.registration.accept')}
    </Button>
  )
}

/**
 * Зона активного поля поверх страницы скана. Распознавание отдаёт текст без
 * координат слов — зоны нет (ADR-0088); поле в фокусе подсвечивает своё
 * предложение в панели помощника.
 */
export function assistOverlay(_props: RegistrationAssistProps, _page: number): ReactNode {
  return null
}
