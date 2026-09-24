import type {
  DatasetField,
  DatasetFieldConvertReport,
  DatasetFieldPatch,
  DatasetRecord,
  FieldSemantic,
  Locale,
  StoredFieldType,
} from '@kchs/contracts'
import { formatDate, formatDateTime, formatNumber, formatPercent } from '@kchs/fields'
import {
  AlertDialog,
  Badge,
  Button,
  Callout,
  Card,
  Checkbox,
  cn,
  Dialog,
  DialogContent,
  Field,
  Histogram,
  IconButton,
  Input,
  KeyValueList,
  ProgressBar,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Settings2, Trash2 } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { ApiError, http } from '~/shared/api/client.js'
import { objectListQuery } from '~/shared/api/queries.js'
import { toFieldKey } from '~/shared/keys.js'
import {
  CONVERTIBLE_TYPES,
  defaultSemantic,
  FIELD_TYPE_CHOICES,
  LOOKUP_TYPES,
  NOT_KEY_TYPES,
  NUMERIC_TYPES,
  PICKABLE_SEMANTICS,
} from './field-types.js'
import { dataKeys, datasetQuery, fieldProfileQuery } from './queries.js'

const NONE = '__none'
const FIELD_KEY = /^[a-z_][a-z0-9_]*$/

/** После правки схемы: датасет, версии и профили полей читаются заново. */
function useSchemaRefresh(datasetId: string) {
  const client = useQueryClient()
  return () => {
    void client.invalidateQueries({ queryKey: dataKeys.dataset(datasetId) })
    void client.invalidateQueries({ queryKey: dataKeys.versions(datasetId) })
    void client.invalidateQueries({ queryKey: ['dataset', datasetId, 'profile'] })
  }
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback
}

const labelOf = (field: DatasetField, locale: Locale) =>
  field.label[locale] ?? field.label.ru ?? field.key

/**
 * Вкладка «Схема» (03-screens.md §5): список полей и панель выбранного поля —
 * профиль и свойства; управляющий добавляет поля, меняет тип и настройки таблицы.
 */
export function SchemaTab({ dataset, canManage }: { dataset: DatasetRecord; canManage: boolean }) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const [selected, setSelected] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [settings, setSettings] = useState(false)
  const field = dataset.fields.find((item) => item.key === selected)

  return (
    <div className="mx-auto grid max-w-[1240px] gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
      <div className="flex min-w-0 flex-col gap-3">
        {canManage ? (
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              icon={<Plus className="size-3.5" />}
              onClick={() => setAdding(true)}
            >
              {t('data.dataset.editor.addField')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              icon={<Settings2 className="size-3.5" />}
              onClick={() => setSettings(true)}
            >
              {t('data.dataset.editor.settings')}
            </Button>
          </div>
        ) : null}
        <Card padded={false}>
          <div className="overflow-x-auto">
            <table className="min-w-full border-collapse text-sm">
              <thead className="bg-surface-2 text-xs text-fg-secondary">
                <tr>
                  <th scope="col" className="px-4 py-2 text-left font-medium">
                    {t('data.dataset.schema.field')}
                  </th>
                  <th scope="col" className="px-4 py-2 text-left font-medium">
                    {t('data.dataset.schema.key')}
                  </th>
                  <th scope="col" className="px-4 py-2 text-left font-medium">
                    {t('data.dataset.schema.type')}
                  </th>
                  <th scope="col" className="px-4 py-2 text-left font-medium">
                    {t('data.dataset.schema.semantic')}
                  </th>
                  <th scope="col" className="px-4 py-2 text-left font-medium">
                    {t('data.dataset.schema.flags')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {dataset.fields.map((item) => (
                  <tr
                    key={item.id}
                    className={cn(
                      'border-t border-line',
                      item.key === selected && 'bg-accent-subtle',
                    )}
                  >
                    <td className="px-4 py-2">
                      <button
                        type="button"
                        aria-pressed={item.key === selected}
                        onClick={() => setSelected(item.key)}
                        className="rounded-xs text-left text-fg hover:text-accent"
                      >
                        {labelOf(item, locale)}
                      </button>
                    </td>
                    <td className="px-4 py-2 font-mono text-xs text-fg-secondary">{item.key}</td>
                    <td className="px-4 py-2 text-fg-secondary">{t(`data.types.${item.type}`)}</td>
                    <td className="px-4 py-2 text-fg-secondary">
                      {t(`data.semantics.${item.semantic}`)}
                    </td>
                    <td className="px-4 py-2">
                      <span className="flex flex-wrap gap-1">
                        {dataset.primaryKey.includes(item.key) ? (
                          <Badge size="sm" tone="accent">
                            {t('data.dataset.schema.primaryKey')}
                          </Badge>
                        ) : null}
                        {dataset.timeField === item.key ? (
                          <Badge size="sm">{t('data.dataset.schema.time')}</Badge>
                        ) : null}
                        {item.required ? (
                          <Badge size="sm">{t('data.dataset.schema.required')}</Badge>
                        ) : null}
                        {item.indexed ? (
                          <Badge size="sm" tone="outline">
                            {t('data.dataset.schema.indexed')}
                          </Badge>
                        ) : null}
                        {item.sensitive ? (
                          <Badge size="sm" tone="warning">
                            {t('data.dataset.schema.sensitive')}
                          </Badge>
                        ) : null}
                        {item.lookup ? (
                          <Badge size="sm" tone="purple">
                            {t('data.dataset.editor.lookup.title')}
                          </Badge>
                        ) : null}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      <div className="min-w-0">
        {field ? (
          <FieldPanel
            key={field.key}
            dataset={dataset}
            field={field}
            canManage={canManage}
            onRemoved={() => setSelected(null)}
          />
        ) : (
          <p className="py-6 text-center text-xs text-fg-muted">{t('data.dataset.profile.pick')}</p>
        )}
      </div>

      {adding ? (
        <AddFieldDialog
          dataset={dataset}
          onClose={() => setAdding(false)}
          onAdded={(key) => {
            setAdding(false)
            setSelected(key)
          }}
        />
      ) : null}
      {settings ? (
        <TableSettingsDialog dataset={dataset} onClose={() => setSettings(false)} />
      ) : null}
    </div>
  )
}

// ─── Панель поля ─────────────────────────────────────────────────────────────

function FieldPanel({
  dataset,
  field,
  canManage,
  onRemoved,
}: {
  dataset: DatasetRecord
  field: DatasetField
  canManage: boolean
  onRemoved: () => void
}) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const toast = useToast()
  const refresh = useSchemaRefresh(dataset.id)
  const [converting, setConverting] = useState(false)
  const [removing, setRemoving] = useState(false)
  const label = labelOf(field, locale)

  const remove = useMutation({
    mutationFn: () => http.delete(`/datasets/${dataset.id}/fields/${field.key}`),
    onSuccess: () => {
      toast.show({ title: t('data.dataset.editor.removed'), tone: 'success' })
      refresh()
      onRemoved()
    },
    onError: (error) => toast.error(errorText(error, t('errors.unknown'))),
  })

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          {label}
          <Badge size="sm">{t(`data.types.${field.type}`)}</Badge>
        </span>
      }
      action={
        canManage ? (
          <span className="flex items-center gap-1">
            {field.type !== 'geometry' ? (
              <Button variant="ghost" size="sm" onClick={() => setConverting(true)}>
                {t('data.dataset.editor.convert.action')}
              </Button>
            ) : null}
            <IconButton
              label={t('data.dataset.editor.remove')}
              size="sm"
              variant="danger"
              onClick={() => setRemoving(true)}
            >
              <Trash2 className="size-3.5" />
            </IconButton>
          </span>
        ) : null
      }
    >
      <Tabs defaultValue="profile">
        <TabsList>
          <TabsTrigger value="profile">{t('data.dataset.editor.tabs.profile')}</TabsTrigger>
          <TabsTrigger value="properties">{t('data.dataset.editor.tabs.properties')}</TabsTrigger>
        </TabsList>
        <TabsContent value="profile" className="pt-3">
          <FieldProfileView datasetId={dataset.id} field={field} />
        </TabsContent>
        <TabsContent value="properties" className="pt-3">
          <FieldPropertiesForm dataset={dataset} field={field} canManage={canManage} />
        </TabsContent>
      </Tabs>

      {converting ? (
        <ConvertTypeDialog dataset={dataset} field={field} onClose={() => setConverting(false)} />
      ) : null}
      <AlertDialog
        open={removing}
        onOpenChange={setRemoving}
        title={t('data.dataset.editor.removeConfirm', { field: label })}
        description={t('data.dataset.editor.removeConsequences')}
        confirmLabel={t('data.dataset.editor.remove')}
        destructive
        loading={remove.isPending}
        onConfirm={() => {
          remove.mutate()
          setRemoving(false)
        }}
      />
    </Card>
  )
}

// ─── Профиль ─────────────────────────────────────────────────────────────────

/** Значение профиля текстом по типу поля: числа и даты — в локали пользователя. */
function profileValue(value: string | null, type: string, locale: Locale): string {
  if (value === null) return '—'
  if (NUMERIC_TYPES.has(type)) return formatNumber(Number(value), {}, { locale })
  if (type === 'date') return formatDate(value, { locale })
  if (type === 'datetime') return formatDateTime(value, { locale })
  return value
}

function FieldProfileView({ datasetId, field }: { datasetId: string; field: DatasetField }) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const { data: profile, error, isLoading } = useQuery(fieldProfileQuery(datasetId, field.key))
  const number = (value: number) => formatNumber(value, {}, { locale })

  if (isLoading) return <Skeleton className="h-32 w-full" />
  if (error || !profile) {
    const restricted = error instanceof ApiError && error.status === 403
    return (
      <Callout tone={restricted ? 'info' : 'danger'}>
        {restricted ? t('data.dataset.profile.restricted') : t('data.dataset.profile.failed')}
      </Callout>
    )
  }
  const filled = profile.rows - profile.empty
  return (
    <div className="flex flex-col gap-4">
      {profile.masked ? <Callout tone="info">{t('data.dataset.profile.masked')}</Callout> : null}
      <KeyValueList
        items={[
          {
            key: 'rows',
            label: t('data.dataset.profile.rows'),
            value: profile.sampled
              ? `${number(profile.rows)} · ${t('data.dataset.profile.sampled')}`
              : number(profile.rows),
          },
          {
            key: 'empty',
            label: t('data.dataset.profile.empty'),
            value: `${number(profile.empty)} · ${formatPercent(
              profile.rows > 0 ? profile.empty / profile.rows : 0,
              {},
              { locale },
            )}`,
          },
          ...(profile.type === 'geometry'
            ? []
            : [
                {
                  key: 'distinct',
                  label: t('data.dataset.profile.distinct'),
                  value: number(profile.distinct),
                },
              ]),
          ...(profile.min !== null
            ? [
                {
                  key: 'min',
                  label: t('data.dataset.profile.min'),
                  value: profileValue(profile.min, profile.type, locale),
                },
                {
                  key: 'max',
                  label: t('data.dataset.profile.max'),
                  value: profileValue(profile.max, profile.type, locale),
                },
              ]
            : []),
          ...(profile.mean !== null
            ? [{ key: 'mean', label: t('data.dataset.profile.mean'), value: number(profile.mean) }]
            : []),
        ]}
      />
      {profile.histogram.length > 0 ? (
        <section
          aria-label={t('data.dataset.profile.distribution')}
          className="flex flex-col gap-1"
        >
          <h3 className="text-xs font-medium text-fg-secondary">
            {t('data.dataset.profile.distribution')}
          </h3>
          <Histogram
            values={profile.histogram.map((bin) => bin.count)}
            label={t('data.dataset.profile.distribution')}
          />
          <div className="flex justify-between text-2xs text-fg-muted tabular">
            <span>{profileValue(profile.histogram[0]?.from ?? null, profile.type, locale)}</span>
            <span>{profileValue(profile.histogram.at(-1)?.to ?? null, profile.type, locale)}</span>
          </div>
        </section>
      ) : null}
      {profile.top.length > 0 ? (
        <section aria-label={t('data.dataset.profile.top')} className="flex flex-col gap-2">
          <h3 className="text-xs font-medium text-fg-secondary">{t('data.dataset.profile.top')}</h3>
          <ul className="flex flex-col gap-1.5">
            {profile.top.map((item) => (
              <li
                key={item.value}
                className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3"
              >
                <span className="truncate text-sm text-fg">{item.value}</span>
                <span className="tabular text-xs text-fg-secondary">{number(item.count)}</span>
                <ProgressBar
                  value={filled > 0 ? item.count / filled : 0}
                  className="col-span-2"
                  label={item.value}
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  )
}

// ─── Свойства поля ───────────────────────────────────────────────────────────

function ChoiceField<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (value: T) => void
  disabled?: boolean
}) {
  return (
    <Field label={label}>
      <Select value={value} onValueChange={(next) => onChange(next as T)} disabled={disabled}>
        <SelectTrigger aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  )
}

type Lookup = NonNullable<DatasetField['lookup']>

function FieldPropertiesForm({
  dataset,
  field,
  canManage,
}: {
  dataset: DatasetRecord
  field: DatasetField
  canManage: boolean
}) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const toast = useToast()
  const refresh = useSchemaRefresh(dataset.id)
  const [label, setLabel] = useState(field.label[locale] ?? field.label.ru ?? '')
  const [description, setDescription] = useState(field.description ?? '')
  const [semantic, setSemantic] = useState<FieldSemantic>(field.semantic)
  const [unit, setUnit] = useState(field.unit ?? '')
  const [precision, setPrecision] = useState(
    field.format?.precision !== undefined ? String(field.format.precision) : '',
  )
  const [required, setRequired] = useState(field.required)
  const [indexed, setIndexed] = useState(field.indexed)
  const [sensitive, setSensitive] = useState(field.sensitive)
  const [lookup, setLookup] = useState<Lookup | null>(field.lookup ?? null)
  const numeric = NUMERIC_TYPES.has(field.type)

  const save = useMutation({
    mutationFn: () => {
      const patch: DatasetFieldPatch = {
        label: { ...field.label, [locale]: label.trim() || field.key },
        description: description.trim() || null,
        semantic,
        unit: unit.trim() || null,
        required,
        sensitive,
        // Индекс — DDL: отправляем только при настоящей смене
        ...(indexed !== field.indexed ? { indexed } : {}),
        ...(numeric
          ? {
              format:
                precision === ''
                  ? { ...field.format, precision: undefined }
                  : { ...field.format, precision: Number(precision) },
            }
          : {}),
        ...(JSON.stringify(lookup) !== JSON.stringify(field.lookup ?? null) ? { lookup } : {}),
      }
      return http.patch<DatasetRecord>(`/datasets/${dataset.id}/fields/${field.key}`, patch)
    },
    onSuccess: () => {
      toast.show({ title: t('data.dataset.editor.saved'), tone: 'success' })
      refresh()
    },
    onError: (error) => toast.error(errorText(error, t('errors.unknown'))),
  })

  const disabled = !canManage
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault()
        save.mutate()
      }}
    >
      <Field label={t('data.dataset.editor.label')}>
        <Input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          disabled={disabled}
          aria-label={t('data.dataset.editor.label')}
        />
      </Field>
      <Field label={t('data.dataset.editor.key')} hint={t('data.dataset.editor.keyHint')}>
        <Input value={field.key} mono readOnly disabled aria-label={t('data.dataset.editor.key')} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <ChoiceField
          label={t('data.dataset.editor.semantic')}
          value={semantic}
          onChange={setSemantic}
          disabled={disabled}
          options={PICKABLE_SEMANTICS.map((value) => ({
            value,
            label: t(`data.semantics.${value}`),
          }))}
        />
        <Field label={t('data.dataset.editor.unit')}>
          <Input
            value={unit}
            onChange={(e) => setUnit(e.target.value)}
            disabled={disabled}
            aria-label={t('data.dataset.editor.unit')}
          />
        </Field>
      </div>
      {numeric ? (
        <Field label={t('data.dataset.editor.precision')}>
          <Input
            type="number"
            min={0}
            max={12}
            value={precision}
            onChange={(e) => setPrecision(e.target.value)}
            disabled={disabled}
            aria-label={t('data.dataset.editor.precision')}
          />
        </Field>
      ) : null}
      <Field label={t('data.dataset.editor.description')}>
        <Textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          disabled={disabled}
          aria-label={t('data.dataset.editor.description')}
        />
      </Field>
      <div className="flex flex-col gap-2">
        <Switch
          checked={required}
          onCheckedChange={setRequired}
          disabled={disabled}
          label={t('data.dataset.editor.required')}
        />
        <Switch
          checked={indexed}
          onCheckedChange={setIndexed}
          disabled={disabled || field.type === 'geometry'}
          label={t('data.dataset.editor.indexed')}
        />
        <Switch
          checked={sensitive}
          onCheckedChange={setSensitive}
          disabled={disabled}
          label={t('data.dataset.editor.sensitive')}
        />
      </div>
      {LOOKUP_TYPES.has(field.type) ? (
        <LookupEditor dataset={dataset} value={lookup} onChange={setLookup} disabled={disabled} />
      ) : null}
      {canManage ? (
        <div className="flex justify-end">
          <Button type="submit" variant="primary" size="sm" loading={save.isPending}>
            {t('data.dataset.editor.save')}
          </Button>
        </div>
      ) : null}
    </form>
  )
}

/** Справочник поля: датасет пространства, поле ключа и поле подписи. */
function LookupEditor({
  dataset,
  value,
  onChange,
  disabled,
}: {
  dataset: DatasetRecord
  value: Lookup | null
  onChange: (value: Lookup | null) => void
  disabled?: boolean
}) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const { data: candidates } = useQuery(
    objectListQuery({ spaceId: dataset.spaceId, types: 'dataset', limit: 100 }),
  )
  const { data: reference } = useQuery({
    ...datasetQuery(value?.datasetId ?? ''),
    enabled: Boolean(value?.datasetId),
  })
  const fields = reference?.fields ?? []

  return (
    <fieldset className="flex flex-col gap-2 rounded-md border border-line p-3">
      <legend className="px-1 text-xs font-medium text-fg-secondary">
        {t('data.dataset.editor.lookup.title')}
      </legend>
      <p className="text-2xs text-fg-muted">{t('data.dataset.editor.lookup.hint')}</p>
      <ChoiceField
        label={t('data.dataset.editor.lookup.dataset')}
        value={value?.datasetId ?? NONE}
        disabled={disabled}
        onChange={(next) =>
          onChange(next === NONE ? null : { datasetId: next, keyField: '', labelField: '' })
        }
        options={[
          { value: NONE, label: t('data.dataset.editor.lookup.none') },
          ...(candidates?.items ?? []).map((item) => ({ value: item.id, label: item.title })),
        ]}
      />
      {value && fields.length > 0 ? (
        <div className="grid grid-cols-2 gap-3">
          <ChoiceField
            label={t('data.dataset.editor.lookup.keyField')}
            value={value.keyField || NONE}
            disabled={disabled}
            onChange={(next) => onChange({ ...value, keyField: next === NONE ? '' : next })}
            options={[
              { value: NONE, label: '—' },
              ...fields.map((item) => ({ value: item.key, label: labelOf(item, locale) })),
            ]}
          />
          <ChoiceField
            label={t('data.dataset.editor.lookup.labelField')}
            value={value.labelField || NONE}
            disabled={disabled}
            onChange={(next) => onChange({ ...value, labelField: next === NONE ? '' : next })}
            options={[
              { value: NONE, label: '—' },
              ...fields.map((item) => ({ value: item.key, label: labelOf(item, locale) })),
            ]}
          />
        </div>
      ) : null}
    </fieldset>
  )
}

// ─── Смена типа ──────────────────────────────────────────────────────────────

function ConvertTypeDialog({
  dataset,
  field,
  onClose,
}: {
  dataset: DatasetRecord
  field: DatasetField
  onClose: () => void
}) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const toast = useToast()
  const refresh = useSchemaRefresh(dataset.id)
  const choices = CONVERTIBLE_TYPES.filter((type) => type !== field.type)
  const [type, setType] = useState<StoredFieldType>(choices[0] ?? 'text')
  const [report, setReport] = useState<DatasetFieldConvertReport | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const number = (value: number) => formatNumber(value, {}, { locale })

  const run = useMutation({
    mutationFn: (apply: boolean) =>
      http.post<DatasetFieldConvertReport>(`/datasets/${dataset.id}/fields/${field.key}/convert`, {
        type,
        dryRun: !apply,
        allowLoss: apply && (report?.failed ?? 0) > 0,
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

function AddFieldDialog({
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
      http.post<DatasetRecord>(`/datasets/${dataset.id}/fields`, {
        key: effectiveKey,
        label: { ru: label.trim() },
        type,
        semantic,
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

function TableSettingsDialog({
  dataset,
  onClose,
}: {
  dataset: DatasetRecord
  onClose: () => void
}) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const toast = useToast()
  const refresh = useSchemaRefresh(dataset.id)
  const [timeField, setTimeField] = useState(dataset.timeField ?? NONE)
  const [primaryKey, setPrimaryKey] = useState<string[]>(dataset.primaryKey)
  const [editable, setEditable] = useState(dataset.settings.editable)
  const [trackHistory, setTrackHistory] = useState(dataset.settings.trackHistory)
  const [rowEvents, setRowEvents] = useState(dataset.settings.rowEvents)
  const [failure, setFailure] = useState<string | null>(null)
  const timeFields = dataset.fields.filter((item) => ['date', 'datetime'].includes(item.type))
  const keyFields = dataset.fields.filter((item) => !NOT_KEY_TYPES.has(item.type))

  const save = useMutation({
    mutationFn: () =>
      http.patch<DatasetRecord>(`/datasets/${dataset.id}`, {
        timeField: timeField === NONE ? null : timeField,
        primaryKey,
        settings: { editable, trackHistory, rowEvents },
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
