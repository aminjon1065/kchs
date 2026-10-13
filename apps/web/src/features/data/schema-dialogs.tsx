import type {
  DatasetField,
  DatasetFieldConvertReport,
  DatasetRecord,
  FieldSemantic,
  StoredFieldType,
} from '@kchs/contracts'
import { formatNumber } from '@kchs/fields'
import {
  Button,
  Callout,
  Checkbox,
  Dialog,
  DialogContent,
  Field,
  Input,
  Switch,
  useToast,
} from '@kchs/ui'
import { useMutation } from '@tanstack/react-query'
import { type ReactNode, useState } from 'react'
import { http } from '~/shared/api/client.js'
import { useLocale } from '~/shared/appearance.js'
import { useT } from '~/shared/i18n.js'
import { toFieldKey } from '~/shared/keys.js'
import {
  CONVERTIBLE_TYPES,
  defaultSemantic,
  FIELD_TYPE_CHOICES,
  NOT_KEY_TYPES,
  PICKABLE_SEMANTICS,
} from './field-types.js'
import {
  ChoiceField,
  errorText,
  FIELD_KEY,
  labelOf,
  NONE,
  useSchemaRefresh,
} from './schema-shared.js'

// ─── Смена типа ──────────────────────────────────────────────────────────────

export function ConvertTypeDialog({
  dataset,
  field,
  onClose,
}: {
  dataset: DatasetRecord
  field: DatasetField
  onClose: () => void
}) {
  const t = useT()
  const locale = useLocale()
  const toast = useToast()
  const refresh = useSchemaRefresh(dataset.id)
  const choices = CONVERTIBLE_TYPES.filter((type) => type !== field.type)
  const [type, setType] = useState<StoredFieldType>(choices[0] ?? 'text')
  const [report, setReport] = useState<DatasetFieldConvertReport | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const number = (value: number) => formatNumber(value, {}, { locale })

  const run = useMutation({
    mutationFn: (apply: boolean) =>
      http.post('/datasets/:id/fields/:key/convert', {
        params: { id: dataset.id, key: field.key },
        body: {
          type,
          dryRun: !apply,
          allowLoss: apply && (report?.failed ?? 0) > 0,
        },
      }),
    onSuccess: (result) => {
      setFailure(null)
      if (result.applied) {
        toast.show({ title: t('data.dataset.editor.convert.done'), tone: 'success' })
        refresh()
        onClose()
      } else {
        setReport(result)
      }
    },
    onError: (error) => setFailure(errorText(error, t('errors.unknown'))),
  })

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title={t('data.dataset.editor.convert.title', { field: labelOf(field, locale) })}
        size="md"
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
            {report ? (
              <Button
                variant={report.failed > 0 ? 'danger' : 'primary'}
                loading={run.isPending}
                onClick={() => run.mutate(true)}
              >
                {report.failed > 0
                  ? t('data.dataset.editor.convert.applyLoss')
                  : t('data.dataset.editor.convert.apply')}
              </Button>
            ) : (
              <Button variant="primary" loading={run.isPending} onClick={() => run.mutate(false)}>
                {t('data.dataset.editor.convert.check')}
              </Button>
            )}
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <ChoiceField
            label={t('data.dataset.editor.convert.to')}
            value={type}
            onChange={(next) => {
              setType(next)
              setReport(null)
            }}
            options={choices.map((value) => ({ value, label: t(`data.types.${value}`) }))}
          />
          {failure ? <Callout tone="danger">{failure}</Callout> : null}
          {report ? (
            <div className="flex flex-col gap-2 text-sm">
              <p className="text-fg-secondary">
                {t('data.dataset.editor.convert.total', { count: report.total })}
              </p>
              {report.failed > 0 ? (
                <Callout
                  tone="warning"
                  title={t('data.dataset.editor.convert.failed', { count: report.failed })}
                >
                  <p className="mb-1 text-xs">{t('data.dataset.editor.convert.sample')}</p>
                  <ul className="flex flex-col gap-0.5 font-mono text-xs">
                    {report.sample.map((item) => (
                      <li key={item.rowId}>
                        #{number(Number(item.rowId))}: {item.value}
                      </li>
                    ))}
                  </ul>
                </Callout>
              ) : (
                <Callout tone="success">{t('data.dataset.editor.convert.ok')}</Callout>
              )}
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ─── Новое поле ──────────────────────────────────────────────────────────────

export function AddFieldDialog({
  dataset,
  onClose,
  onAdded,
}: {
  dataset: DatasetRecord
  onClose: () => void
  onAdded: (key: string) => void
}) {
  const t = useT()
  const toast = useToast()
  const refresh = useSchemaRefresh(dataset.id)
  const [label, setLabel] = useState('')
  const [key, setKey] = useState('')
  const [type, setType] = useState<StoredFieldType>('text')
  const [semantic, setSemantic] = useState<FieldSemantic>('dimension')
  const [failure, setFailure] = useState<string | null>(null)
  const effectiveKey = key || toFieldKey(label)
  const keyValid =
    FIELD_KEY.test(effectiveKey) &&
    effectiveKey.length <= 64 &&
    !dataset.fields.some((item) => item.key === effectiveKey)

  const add = useMutation({
    mutationFn: () =>
      http.post('/datasets/:id/fields', {
        params: { id: dataset.id },
        body: {
          key: effectiveKey,
          label: { ru: label.trim() },
          type,
          semantic,
        },
      }),
    onSuccess: () => {
      toast.show({ title: t('data.dataset.editor.added'), tone: 'success' })
      refresh()
      onAdded(effectiveKey)
    },
    onError: (error) => setFailure(errorText(error, t('errors.unknown'))),
  })

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title={t('data.dataset.editor.addField')}
        size="md"
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={!label.trim() || !keyValid}
              loading={add.isPending}
              onClick={() => add.mutate()}
            >
              {t('common.actions.create')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {failure ? <Callout tone="danger">{failure}</Callout> : null}
          <Field label={t('data.dataset.editor.label')} required>
            <Input
              autoFocus
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              aria-label={t('data.dataset.editor.label')}
            />
          </Field>
          <Field
            label={t('data.dataset.editor.key')}
            hint={t('data.dataset.editor.keyHint')}
            error={
              effectiveKey && !keyValid ? t('data.import.mapping.errors.keyFormat') : undefined
            }
          >
            <Input
              mono
              value={effectiveKey}
              onChange={(e) => setKey(toFieldKey(e.target.value))}
              aria-label={t('data.dataset.editor.key')}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <ChoiceField
              label={t('data.dataset.editor.type')}
              value={type}
              onChange={(next) => {
                setType(next)
                setSemantic(defaultSemantic(next))
              }}
              options={FIELD_TYPE_CHOICES.map((value) => ({
                value,
                label: t(`data.types.${value}`),
              }))}
            />
            <ChoiceField
              label={t('data.dataset.editor.semantic')}
              value={semantic}
              onChange={setSemantic}
              options={PICKABLE_SEMANTICS.map((value) => ({
                value,
                label: t(`data.semantics.${value}`),
              }))}
            />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ─── Настройки таблицы ───────────────────────────────────────────────────────

export function TableSettingsDialog({
  dataset,
  onClose,
}: {
  dataset: DatasetRecord
  onClose: () => void
}) {
  const t = useT()
  const locale = useLocale()
  const toast = useToast()
  const refresh = useSchemaRefresh(dataset.id)
  const [timeField, setTimeField] = useState(dataset.timeField ?? NONE)
  const [primaryKey, setPrimaryKey] = useState<string[]>(dataset.primaryKey)
  const [editable, setEditable] = useState(dataset.settings.editable)
  const [trackHistory, setTrackHistory] = useState(dataset.settings.trackHistory)
  // Срок хранения истории (ADR-0173): пусто — бессрочно
  const [retention, setRetention] = useState(
    dataset.settings.historyRetentionDays === null
      ? ''
      : String(dataset.settings.historyRetentionDays),
  )
  const [rowEvents, setRowEvents] = useState(dataset.settings.rowEvents)
  const [failure, setFailure] = useState<string | null>(null)
  const timeFields = dataset.fields.filter((item) => ['date', 'datetime'].includes(item.type))
  const keyFields = dataset.fields.filter((item) => !NOT_KEY_TYPES.has(item.type))

  const save = useMutation({
    mutationFn: () =>
      http.patch('/datasets/:id', {
        params: { id: dataset.id },
        body: {
          timeField: timeField === NONE ? null : timeField,
          primaryKey,
          settings: {
            editable,
            trackHistory,
            rowEvents,
            historyRetentionDays: retention.trim() === '' ? null : Number(retention),
          },
        },
      }),
    onSuccess: () => {
      toast.show({ title: t('data.dataset.editor.settingsDialog.saved'), tone: 'success' })
      refresh()
      onClose()
    },
    onError: (error) => setFailure(errorText(error, t('errors.unknown'))),
  })

  let keys: ReactNode = null
  if (keyFields.length > 0) {
    keys = (
      <Field
        label={t('data.dataset.editor.settingsDialog.primaryKey')}
        hint={t('data.dataset.editor.settingsDialog.primaryKeyHint')}
      >
        <div className="flex flex-col gap-1.5">
          {keyFields.map((item) => (
            <Checkbox
              key={item.key}
              label={labelOf(item, locale)}
              checked={primaryKey.includes(item.key)}
              onCheckedChange={(checked) =>
                setPrimaryKey((current) =>
                  checked === true
                    ? [...current, item.key]
                    : current.filter((key) => key !== item.key),
                )
              }
            />
          ))}
        </div>
      </Field>
    )
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title={t('data.dataset.editor.settings')}
        size="md"
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
            <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
              {t('data.dataset.editor.save')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {failure ? <Callout tone="danger">{failure}</Callout> : null}
          <ChoiceField
            label={t('data.dataset.editor.settingsDialog.timeField')}
            value={timeField}
            onChange={setTimeField}
            options={[
              { value: NONE, label: t('data.dataset.editor.settingsDialog.none') },
              ...timeFields.map((item) => ({ value: item.key, label: labelOf(item, locale) })),
            ]}
          />
          {keys}
          <div className="flex flex-col gap-2">
            <Switch
              checked={editable}
              onCheckedChange={setEditable}
              label={t('data.dataset.editor.settingsDialog.editable')}
            />
            <Switch
              checked={trackHistory}
              onCheckedChange={setTrackHistory}
              label={t('data.dataset.editor.settingsDialog.trackHistory')}
            />
            {trackHistory ? (
              <Field
                label={t('data.dataset.editor.settingsDialog.historyRetention')}
                hint={t('data.dataset.editor.settingsDialog.historyRetentionHint')}
              >
                <Input
                  type="number"
                  min={1}
                  max={3650}
                  step={1}
                  value={retention}
                  onChange={(e) => setRetention(e.target.value)}
                  placeholder={t('data.dataset.editor.settingsDialog.historyRetentionForever')}
                  aria-label={t('data.dataset.editor.settingsDialog.historyRetention')}
                />
              </Field>
            ) : null}
            <Switch
              checked={rowEvents}
              onCheckedChange={setRowEvents}
              label={t('data.dataset.editor.settingsDialog.rowEvents')}
            />
            {rowEvents ? (
              <Callout tone="info">{t('data.dataset.editor.settingsDialog.rowEventsHint')}</Callout>
            ) : null}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
