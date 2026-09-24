import {
  type DatasetField,
  FEED_FORMATS,
  FEED_TRANSFORMS,
  FeedConfig,
  type FeedFormat,
  type FeedPathInfo,
  type FeedPreview,
  type FeedTransform,
  type SourceRecord,
} from '@kchs/contracts'
import {
  Badge,
  Button,
  Callout,
  Card,
  Checkbox,
  Dialog,
  DialogContent,
  Field,
  Input,
  SegmentedControl,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Stepper,
} from '@kchs/ui'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useId, useState } from 'react'
import { useT } from '~/app/i18n.js'
import { datasetQuery } from '~/features/data/queries.js'
import { ObjectPicker } from '~/features/notebooks/object-picker.js'
import { ApiError } from '~/shared/api/client.js'
import { integrationsQuery, spacesQuery } from '~/shared/api/queries.js'
import { orderSpaces } from '~/shared/spaces.js'
import {
  configFromDraft,
  datasetFields,
  draftFromConfig,
  draftProblems,
  emptyDraft,
  emptyMapping,
  FEED_VALUE_KINDS,
  type FeedDraft,
  type FeedValueKind,
  type GeometrySource,
  type MappingDraft,
  NEW_FIELD_TYPES,
  NEW_GEOMETRY_FIELD,
  NEW_TERRITORY_FIELD,
  type NewFieldDraft,
  type NewFieldType,
  newFieldsFor,
  TAJIKISTAN_BBOX,
} from './feed-form.js'
import { sourceApi } from './queries.js'

const STEPS = ['address', 'fields', 'schedule'] as const
const NONE = '__none'
/** Поля геометрии и территории заполняет не сопоставление, а своя настройка ленты. */
const SPECIAL_TYPES = new Set(['geometry', 'territory'])
/** Столько записей предпросмотра показывается таблицей. */
const PREVIEW_ROWS = 5
const PREVIEW_COLUMNS = 6
/** Ссылка на секрет интеграции в адресе — образец для подсказки. */
const SECRET_EXAMPLE = '{secret:mapKey}'
/** Шаблон ключа ленты без идентификатора — образец поля ввода (NASA FIRMS). */
const TEMPLATE_EXAMPLE = '{latitude}_{longitude}_{acq_date}'

function problemMessage(err: unknown, fallback: string): string {
  if (!(err instanceof ApiError)) return fallback
  const field = Object.values(err.fieldErrors())[0]
  return field && !field.includes('.') ? `${err.message}: ${field}` : err.message
}

function sample(value: unknown): string {
  if (value === null || value === undefined) return '—'
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value)
  return text.length > 60 ? `${text.slice(0, 57)}…` : text
}

/** Столбец нового датасета: путь записи и поле, которое из него заводится. */
interface NewColumn extends NewFieldDraft {
  path: string
}

/**
 * Мастер ленты по адресу (ADR-0132): адрес и формат с проверкой ответа → датасет-
 * приёмник и сопоставление полей, геометрия, район, область и ключ → название и
 * расписание. Правка существующей ленты открывает тот же мастер со своим датасетом.
 */
export function FeedSourceDialog({
  open,
  source,
  onOpenChange,
  onSaved,
}: {
  open: boolean
  /** Лента для правки; null — новая. */
  source: SourceRecord | null
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}) {
  const t = useT()
  const formId = useId()
  const { data: integrations = [] } = useQuery(integrationsQuery())
  const { data: spaces = [] } = useQuery(spacesQuery())
  const available = orderSpaces(spaces)
  const secretsSources = integrations.filter(
    (item) => item.kind === 'http' && item.source === 'object',
  )

  const [opened, setOpened] = useState<{ open: boolean; id: string | null }>({
    open: false,
    id: null,
  })
  const [step, setStep] = useState(0)
  const [draft, setDraft] = useState<FeedDraft>(emptyDraft)
  const [preview, setPreview] = useState<FeedPreview | null>(null)
  const [target, setTarget] = useState<'existing' | 'new'>('existing')
  const [spaceId, setSpaceId] = useState('')
  const [datasetId, setDatasetId] = useState('')
  const [columns, setColumns] = useState<NewColumn[]>([])
  const [locate, setLocate] = useState(true)
  const [name, setName] = useState('')
  const [datasetName, setDatasetName] = useState('')
  const [schedule, setSchedule] = useState('*/15 * * * *')
  const [enabled, setEnabled] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Мастер открыт заново — состояние с нуля или из правимой ленты
  if (opened.open !== open || opened.id !== (source?.id ?? null)) {
    setOpened({ open, id: source?.id ?? null })
    setStep(0)
    setPreview(null)
    setError(null)
    setColumns([])
    setLocate(true)
    setDatasetName('')
    if (source?.feed) {
      setDraft(draftFromConfig(source.feed, source.integrationId))
      setTarget('existing')
      setSpaceId(source.spaceId)
      setDatasetId(source.datasetId ?? '')
      setName(source.name)
      setSchedule(source.schedule ?? '')
      setEnabled(source.enabled)
    } else {
      setDraft(emptyDraft())
      setTarget('existing')
      setSpaceId('')
      setDatasetId('')
      setName('')
      setSchedule('*/15 * * * *')
      setEnabled(true)
    }
  }

  const targetSpace = spaceId || available[0]?.id || ''
  const editing = source !== null
  const { data: dataset } = useQuery({
    ...datasetQuery(datasetId),
    enabled: target === 'existing' && datasetId.length > 0,
  })
  const paths = preview?.paths ?? []
  const patch = (next: Partial<FeedDraft>) => setDraft((current) => ({ ...current, ...next }))

  const check = useMutation({
    mutationFn: () =>
      sourceApi.previewFeed({
        url: draft.url.trim(),
        headers: {},
        format: draft.format,
        itemsPath:
          draft.format === 'json' && draft.itemsPath.trim() ? draft.itemsPath.trim() : null,
        integrationId: draft.integrationId || null,
        limit: 20,
      }),
    onSuccess: (result) => {
      setPreview(result)
      setError(null)
    },
    onError: (err) => {
      setPreview(null)
      setError(problemMessage(err, t('errors.unknown')))
    },
  })

  /** Черновик с полями, заведёнными для нового датасета. */
  const effective = (): FeedDraft => {
    if (target === 'existing') return draft
    const located = draft.geometry !== 'none'
    return {
      ...draft,
      mapping: Object.fromEntries(
        columns.map((column) => [
          column.key,
          { ...emptyMapping(), kind: 'path' as const, path: column.path },
        ]),
      ),
      geometryField: located ? NEW_GEOMETRY_FIELD : '',
      territoryField: located && locate ? NEW_TERRITORY_FIELD : '',
    }
  }

  const save = useMutation({
    mutationFn: async () => {
      const current = effective()
      const feed = FeedConfig.parse(configFromDraft(current))
      if (source) {
        return sourceApi.update(source.id, {
          name: name.trim(),
          feed,
          integrationId: draft.integrationId || null,
          schedule: schedule.trim() || null,
          enabled,
        })
      }
      return sourceApi.createFeed({
        name: name.trim(),
        spaceId: targetSpace,
        integrationId: draft.integrationId || null,
        feed,
        target:
          target === 'existing'
            ? { kind: 'existing', datasetId }
            : {
                kind: 'new',
                name: datasetName.trim() || name.trim(),
                fields: datasetFields(columns, feed.keyFields, current),
              },
        schedule: schedule.trim() || null,
        enabled,
      })
    },
    onSuccess: () => {
      onSaved()
      onOpenChange(false)
    },
    onError: (err) => setError(problemMessage(err, t('errors.unknown'))),
  })

  const problems = draftProblems(effective())
  const stepReady = [
    // Адрес проверен предпросмотром; у правки — адрес уже рабочий
    problems.includes('url') === false && (preview !== null || editing),
    (target === 'existing' ? datasetId.length > 0 : columns.length > 0) &&
      !problems.includes('mapping') &&
      !problems.includes('key') &&
      !problems.includes('geometry'),
    name.trim().length > 0 && targetSpace.length > 0,
  ]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={
          editing
            ? t('admin.dataSources.feed.editTitle', { name: source.name })
            : t('admin.dataSources.feed.add')
        }
        description={t('admin.dataSources.feed.addHint')}
        size="xl"
        footer={
          <>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              {t('common.actions.cancel')}
            </Button>
            {step > 0 ? (
              <Button variant="secondary" onClick={() => setStep(step - 1)}>
                {t('admin.dataSources.feed.back')}
              </Button>
            ) : null}
            {/* Разные ключи: иначе React превратит «Далее» в кнопку отправки прямо
                во время клика, и тот же клик отправит форму */}
            {step < STEPS.length - 1 ? (
              <Button
                key="next"
                variant="primary"
                disabled={!stepReady[step]}
                onClick={() => setStep(step + 1)}
              >
                {t('admin.dataSources.feed.next')}
              </Button>
            ) : (
              <Button
                key="submit"
                type="submit"
                form={formId}
                variant="primary"
                disabled={!stepReady.every(Boolean)}
                loading={save.isPending}
              >
                {editing ? t('common.actions.save') : t('admin.dataSources.feed.create')}
              </Button>
            )}
          </>
        }
      >
        <form
          id={formId}
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (stepReady.every(Boolean)) save.mutate()
          }}
        >
          <Stepper
            aria-label={t('admin.dataSources.feed.steps.label')}
            steps={STEPS.map((key) => ({ key, label: t(`admin.dataSources.feed.steps.${key}`) }))}
            current={step}
            onStepClick={setStep}
          />
          {error ? <Callout tone="danger">{error}</Callout> : null}
          {step === 0 ? (
            <AddressStep
              draft={draft}
              onChange={patch}
              integrations={secretsSources.map((item) => ({ id: item.id, name: item.name }))}
              preview={preview}
              checking={check.isPending}
              onCheck={() => check.mutate()}
            />
          ) : null}
          {step === 1 ? (
            <div className="flex flex-col gap-4">
              {editing ? null : (
                <div className="flex flex-wrap items-end gap-3">
                  <Field label={t('admin.dataSources.feed.target')}>
                    <SegmentedControl
                      value={target}
                      onValueChange={(value) => {
                        setTarget(value)
                        patch({ keyFields: [], geometryField: '', territoryField: '' })
                      }}
                      options={[
                        { value: 'existing', label: t('admin.dataSources.feed.targetExisting') },
                        { value: 'new', label: t('admin.dataSources.feed.targetNew') },
                      ]}
                      aria-label={t('admin.dataSources.feed.target')}
                    />
                  </Field>
                  <Field label={t('admin.dataSources.fields.space')} htmlFor={`${formId}-space`}>
                    <Select
                      value={targetSpace}
                      onValueChange={(value) => {
                        setSpaceId(value)
                        setDatasetId('')
                      }}
                    >
                      <SelectTrigger id={`${formId}-space`} className="w-56">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {available.map((space) => (
                          <SelectItem key={space.id} value={space.id}>
                            {space.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  {target === 'existing' ? (
                    <Field label={t('admin.dataSources.feed.dataset')}>
                      <ObjectPicker
                        type="dataset"
                        value={datasetId || null}
                        onChange={(id) => {
                          setDatasetId(id)
                          patch({
                            mapping: {},
                            keyFields: [],
                            geometryField: '',
                            territoryField: '',
                          })
                        }}
                        label={t('admin.dataSources.feed.dataset')}
                        placeholder={t('admin.dataSources.feed.datasetPlaceholder')}
                        spaceId={targetSpace || null}
                      />
                    </Field>
                  ) : null}
                </div>
              )}
              {target === 'existing' ? (
                dataset ? (
                  <ExistingMapping
                    fields={dataset.fields}
                    draft={draft}
                    paths={paths}
                    onChange={patch}
                  />
                ) : (
                  <Callout tone="info">{t('admin.dataSources.feed.pickDataset')}</Callout>
                )
              ) : (
                <NewColumns
                  paths={paths}
                  columns={columns}
                  onColumnsChange={setColumns}
                  keyFields={draft.keyFields}
                  onKeyFieldsChange={(keyFields) => patch({ keyFields })}
                  datasetName={datasetName}
                  onDatasetNameChange={setDatasetName}
                />
              )}
              <LocationSection
                draft={draft}
                paths={paths}
                onChange={patch}
                geometryFields={
                  target === 'existing'
                    ? (dataset?.fields ?? []).filter((field) => field.type === 'geometry')
                    : null
                }
                territoryFields={
                  target === 'existing'
                    ? (dataset?.fields ?? []).filter((field) => field.type === 'territory')
                    : null
                }
                locate={locate}
                onLocateChange={setLocate}
              />
            </div>
          ) : null}
          {step === 2 ? (
            <div className="flex flex-col gap-3">
              <Field label={t('admin.dataSources.fields.name')} htmlFor={`${formId}-name`} required>
                <Input
                  id={`${formId}-name`}
                  maxLength={200}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </Field>
              <Field
                label={t('admin.dataSources.fields.schedule')}
                htmlFor={`${formId}-cron`}
                hint={t('admin.dataSources.feed.scheduleHint')}
              >
                <Input
                  id={`${formId}-cron`}
                  className="font-mono"
                  value={schedule}
                  onChange={(event) => setSchedule(event.target.value)}
                />
              </Field>
              <Checkbox
                label={t('admin.dataSources.fields.enabled')}
                checked={enabled}
                onCheckedChange={(checked) => setEnabled(checked === true)}
              />
            </div>
          ) : null}
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** Шаг «Адрес»: URL, формат, путь к массиву, интеграция с секретами и проверка ответа. */
function AddressStep({
  draft,
  onChange,
  integrations,
  preview,
  checking,
  onCheck,
}: {
  draft: FeedDraft
  onChange: (next: Partial<FeedDraft>) => void
  integrations: Array<{ id: string; name: string }>
  preview: FeedPreview | null
  checking: boolean
  onCheck: () => void
}) {
  const t = useT()
  const id = useId()
  const columns = (preview?.paths ?? []).slice(0, PREVIEW_COLUMNS)
  return (
    <div className="flex flex-col gap-3">
      <Field
        label={t('admin.dataSources.feed.url')}
        htmlFor={`${id}-url`}
        hint={t('admin.dataSources.feed.urlHint', { example: SECRET_EXAMPLE })}
        required
      >
        <Input
          id={`${id}-url`}
          className="font-mono"
          placeholder="https://"
          value={draft.url}
          onChange={(event) => onChange({ url: event.target.value })}
        />
      </Field>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label={t('admin.dataSources.feed.format')} htmlFor={`${id}-format`}>
          <Select
            value={draft.format}
            onValueChange={(value) => onChange({ format: value as FeedFormat })}
          >
            <SelectTrigger id={`${id}-format`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FEED_FORMATS.map((format) => (
                <SelectItem key={format} value={format}>
                  {t(`admin.dataSources.feed.formats.${format}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        {draft.format === 'json' ? (
          <Field
            label={t('admin.dataSources.feed.itemsPath')}
            htmlFor={`${id}-items`}
            hint={t('admin.dataSources.feed.itemsPathHint')}
          >
            <Input
              id={`${id}-items`}
              className="font-mono"
              value={draft.itemsPath}
              onChange={(event) => onChange({ itemsPath: event.target.value })}
            />
          </Field>
        ) : null}
        <Field
          label={t('admin.dataSources.feed.integration')}
          htmlFor={`${id}-integration`}
          hint={t('admin.dataSources.feed.integrationHint')}
        >
          <Select
            value={draft.integrationId || NONE}
            onValueChange={(value) => onChange({ integrationId: value === NONE ? '' : value })}
          >
            <SelectTrigger id={`${id}-integration`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>{t('admin.dataSources.feed.noIntegration')}</SelectItem>
              {integrations.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {item.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          loading={checking}
          disabled={!/^https?:\/\/\S+$/i.test(draft.url.trim())}
          onClick={onCheck}
        >
          {t('admin.dataSources.feed.check')}
        </Button>
        {preview ? (
          <Badge tone="success" size="sm" dot>
            {t('admin.dataSources.feed.found', {
              records: String(preview.total),
              paths: String(preview.paths.length),
            })}
          </Badge>
        ) : null}
      </div>
      {preview && preview.items.length > 0 ? (
        <Card padded={false}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-max text-xs">
              <thead>
                <tr className="border-b border-line text-left text-fg-secondary">
                  {columns.map((column) => (
                    <th key={column.path} className="px-2 py-1.5 font-medium">
                      <span className="font-mono">{column.path}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.items.slice(0, PREVIEW_ROWS).map((item, index) => (
                  <tr key={index} className="border-b border-line last:border-0">
                    {columns.map((column) => (
                      <td key={column.path} className="max-w-[16rem] truncate px-2 py-1.5 text-fg">
                        {sample(item[column.path])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}
    </div>
  )
}

/** Выбор пути записи ленты: пути предпросмотра с примером значения. */
function PathSelect({
  value,
  onChange,
  paths,
  label,
  className,
}: {
  value: string
  onChange: (path: string) => void
  paths: readonly FeedPathInfo[]
  label: string
  className?: string
}) {
  const t = useT()
  const known = !value || paths.some((info) => info.path === value)
  return (
    <Select value={value || NONE} onValueChange={(next) => onChange(next === NONE ? '' : next)}>
      <SelectTrigger aria-label={label} className={className ?? 'h-7 text-xs'}>
        <SelectValue placeholder={t('admin.dataSources.feed.pickPath')} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>{t('admin.dataSources.feed.pickPath')}</SelectItem>
        {known ? null : <SelectItem value={value}>{value}</SelectItem>}
        {paths.map((info) => (
          <SelectItem key={info.path} value={info.path}>
            <span className="font-mono">{info.path}</span>
            <span className="ml-2 text-fg-muted">{sample(info.sample)}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** Сопоставление полей существующего датасета с записью ленты и выбор ключа. */
function ExistingMapping({
  fields,
  draft,
  paths,
  onChange,
}: {
  fields: DatasetField[]
  draft: FeedDraft
  paths: readonly FeedPathInfo[]
  onChange: (next: Partial<FeedDraft>) => void
}) {
  const t = useT()
  const editable = fields.filter((field) => !SPECIAL_TYPES.has(field.type) && !field.readOnly)
  const setMapping = (key: string, next: Partial<MappingDraft>) =>
    onChange({
      mapping: { ...draft.mapping, [key]: { ...(draft.mapping[key] ?? emptyMapping()), ...next } },
    })
  return (
    <Card padded={false}>
      <div className="border-b border-line px-3 py-2 text-xs text-fg-secondary">
        {t('admin.dataSources.feed.mappingHint')}
      </div>
      <ul className="max-h-80 divide-y divide-line overflow-y-auto">
        {editable.map((field) => {
          const mapping = draft.mapping[field.key] ?? emptyMapping()
          const label = field.label.ru
          return (
            <li
              key={field.key}
              className="flex flex-col gap-2 px-3 py-2 sm:flex-row sm:items-center"
            >
              <div className="min-w-0 sm:w-48">
                <div className="truncate text-sm text-fg">{label}</div>
                <div className="font-mono text-2xs text-fg-muted">
                  {field.key} · {field.type}
                </div>
              </div>
              <Select
                value={mapping.kind}
                onValueChange={(value) => setMapping(field.key, { kind: value as FeedValueKind })}
              >
                <SelectTrigger
                  aria-label={t('admin.dataSources.feed.sourceOf', { field: label })}
                  className="h-7 text-xs sm:w-40"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FEED_VALUE_KINDS.map((kind) => (
                    <SelectItem key={kind} value={kind}>
                      {t(`admin.dataSources.feed.kinds.${kind}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                {mapping.kind === 'path' ? (
                  <>
                    <PathSelect
                      value={mapping.path}
                      onChange={(path) => setMapping(field.key, { path })}
                      paths={paths}
                      label={t('admin.dataSources.feed.pathOf', { field: label })}
                      className="h-7 min-w-0 flex-1 text-xs"
                    />
                    <Select
                      value={mapping.transform}
                      onValueChange={(value) =>
                        setMapping(field.key, { transform: value as FeedTransform })
                      }
                    >
                      <SelectTrigger
                        aria-label={t('admin.dataSources.feed.transformOf', { field: label })}
                        className="h-7 w-36 text-xs"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {FEED_TRANSFORMS.map((transform) => (
                          <SelectItem key={transform} value={transform}>
                            {t(`admin.dataSources.feed.transforms.${transform}`)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </>
                ) : null}
                {mapping.kind === 'const' ? (
                  <Input
                    aria-label={t('admin.dataSources.feed.constantOf', { field: label })}
                    className="h-7 text-xs"
                    value={mapping.constant}
                    onChange={(event) => setMapping(field.key, { constant: event.target.value })}
                  />
                ) : null}
                {mapping.kind === 'template' ? (
                  <Input
                    aria-label={t('admin.dataSources.feed.templateOf', { field: label })}
                    className="h-7 font-mono text-xs"
                    placeholder={TEMPLATE_EXAMPLE}
                    value={mapping.template}
                    onChange={(event) => setMapping(field.key, { template: event.target.value })}
                  />
                ) : null}
                {mapping.kind === 'date_time' ? (
                  <>
                    <PathSelect
                      value={mapping.date}
                      onChange={(date) => setMapping(field.key, { date })}
                      paths={paths}
                      label={t('admin.dataSources.feed.dateOf', { field: label })}
                      className="h-7 min-w-0 flex-1 text-xs"
                    />
                    <PathSelect
                      value={mapping.time}
                      onChange={(time) => setMapping(field.key, { time })}
                      paths={paths}
                      label={t('admin.dataSources.feed.timeOf', { field: label })}
                      className="h-7 min-w-0 flex-1 text-xs"
                    />
                  </>
                ) : null}
              </div>
              <Checkbox
                label={t('admin.dataSources.feed.key')}
                checked={draft.keyFields.includes(field.key)}
                disabled={mapping.kind === 'none'}
                onCheckedChange={(checked) =>
                  onChange({
                    keyFields:
                      checked === true
                        ? [...draft.keyFields, field.key]
                        : draft.keyFields.filter((key) => key !== field.key),
                  })
                }
              />
            </li>
          )
        })}
      </ul>
    </Card>
  )
}

/** Новый датасет: отмеченные пути записи становятся полями с ключом, подписью и типом. */
function NewColumns({
  paths,
  columns,
  onColumnsChange,
  keyFields,
  onKeyFieldsChange,
  datasetName,
  onDatasetNameChange,
}: {
  paths: readonly FeedPathInfo[]
  columns: NewColumn[]
  onColumnsChange: (columns: NewColumn[]) => void
  keyFields: string[]
  onKeyFieldsChange: (keys: string[]) => void
  datasetName: string
  onDatasetNameChange: (name: string) => void
}) {
  const t = useT()
  const id = useId()
  const plain = paths.filter((info) => info.type !== 'geometry')
  const toggle = (info: FeedPathInfo, checked: boolean) => {
    if (!checked) {
      const removed = columns.find((column) => column.path === info.path)
      onColumnsChange(columns.filter((column) => column.path !== info.path))
      if (removed) onKeyFieldsChange(keyFields.filter((key) => key !== removed.key))
      return
    }
    const [field] = newFieldsFor([info]).map((draft) => ({
      ...draft,
      key: uniqueKey(draft.key, columns),
    }))
    if (field) onColumnsChange([...columns, { ...field, path: info.path }])
  }
  const update = (path: string, next: Partial<NewFieldDraft>) =>
    onColumnsChange(
      columns.map((column) => (column.path === path ? { ...column, ...next } : column)),
    )
  return (
    <div className="flex flex-col gap-3">
      <Field
        label={t('admin.dataSources.feed.datasetName')}
        htmlFor={`${id}-dataset`}
        hint={t('admin.dataSources.feed.datasetNameHint')}
      >
        <Input
          id={`${id}-dataset`}
          maxLength={200}
          value={datasetName}
          onChange={(event) => onDatasetNameChange(event.target.value)}
        />
      </Field>
      <Card padded={false}>
        <div className="border-b border-line px-3 py-2 text-xs text-fg-secondary">
          {t('admin.dataSources.feed.newFieldsHint')}
        </div>
        <ul className="max-h-80 divide-y divide-line overflow-y-auto">
          {plain.map((info) => {
            const column = columns.find((item) => item.path === info.path)
            return (
              <li
                key={info.path}
                className="flex flex-col gap-2 px-3 py-2 sm:flex-row sm:items-center"
              >
                <Checkbox
                  label={info.path}
                  checked={Boolean(column)}
                  onCheckedChange={(checked) => toggle(info, checked === true)}
                />
                <span className="truncate text-xs text-fg-muted sm:w-40">
                  {sample(info.sample)}
                </span>
                {column ? (
                  <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                    <Input
                      aria-label={t('admin.dataSources.feed.fieldLabelOf', { path: info.path })}
                      className="h-7 min-w-0 flex-1 text-xs"
                      value={column.label}
                      onChange={(event) => update(info.path, { label: event.target.value })}
                    />
                    <Select
                      value={column.type}
                      onValueChange={(value) => update(info.path, { type: value as NewFieldType })}
                    >
                      <SelectTrigger
                        aria-label={t('admin.dataSources.feed.fieldTypeOf', { path: info.path })}
                        className="h-7 w-36 text-xs"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {NEW_FIELD_TYPES.map((type) => (
                          <SelectItem key={type} value={type}>
                            {t(`admin.dataSources.feed.types.${type}`)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Checkbox
                      label={t('admin.dataSources.feed.key')}
                      checked={keyFields.includes(column.key)}
                      onCheckedChange={(checked) =>
                        onKeyFieldsChange(
                          checked === true
                            ? [...keyFields, column.key]
                            : keyFields.filter((key) => key !== column.key),
                        )
                      }
                    />
                  </div>
                ) : null}
              </li>
            )
          })}
        </ul>
      </Card>
    </div>
  )
}

function uniqueKey(key: string, columns: readonly NewColumn[]): string {
  const taken = new Set([
    ...columns.map((column) => column.key),
    NEW_GEOMETRY_FIELD,
    NEW_TERRITORY_FIELD,
  ])
  let next = key
  for (let index = 2; taken.has(next); index++) next = `${key}_${index}`
  return next
}

/** Геометрия записи, поле для неё и район, область отбора и «только внутри территорий». */
function LocationSection({
  draft,
  paths,
  onChange,
  geometryFields,
  territoryFields,
  locate,
  onLocateChange,
}: {
  draft: FeedDraft
  paths: readonly FeedPathInfo[]
  onChange: (next: Partial<FeedDraft>) => void
  /** Поля существующего датасета; null — новый датасет, поля заводятся сами. */
  geometryFields: DatasetField[] | null
  territoryFields: DatasetField[] | null
  locate: boolean
  onLocateChange: (value: boolean) => void
}) {
  const t = useT()
  const id = useId()
  const located = draft.geometry !== 'none'
  const bbox = draft.bbox ?? ['', '', '', '']
  const setBbox = (index: number, value: string) => {
    const next = [...bbox] as [string, string, string, string]
    next[index] = value
    onChange({ bbox: next.every((item) => item === '') ? null : next })
  }
  return (
    <Card>
      <div className="flex flex-col gap-3">
        <Field label={t('admin.dataSources.feed.geometry')}>
          <SegmentedControl
            value={draft.geometry}
            onValueChange={(value) => onChange({ geometry: value as GeometrySource })}
            options={(['none', 'feature', 'latlon'] as const).map((value) => ({
              value,
              label: t(`admin.dataSources.feed.geometrySources.${value}`),
            }))}
            aria-label={t('admin.dataSources.feed.geometry')}
          />
        </Field>
        {draft.geometry === 'latlon' ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label={t('admin.dataSources.feed.lat')}>
              <PathSelect
                value={draft.lat}
                onChange={(lat) => onChange({ lat })}
                paths={paths}
                label={t('admin.dataSources.feed.lat')}
                className="h-8 text-sm"
              />
            </Field>
            <Field label={t('admin.dataSources.feed.lon')}>
              <PathSelect
                value={draft.lon}
                onChange={(lon) => onChange({ lon })}
                paths={paths}
                label={t('admin.dataSources.feed.lon')}
                className="h-8 text-sm"
              />
            </Field>
          </div>
        ) : null}
        {located ? (
          <>
            {geometryFields && territoryFields ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label={t('admin.dataSources.feed.geometryField')} htmlFor={`${id}-geometry`}>
                  <Select
                    value={draft.geometryField || NONE}
                    onValueChange={(value) =>
                      onChange({ geometryField: value === NONE ? '' : value })
                    }
                  >
                    <SelectTrigger id={`${id}-geometry`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>{t('admin.dataSources.feed.noField')}</SelectItem>
                      {geometryFields.map((field) => (
                        <SelectItem key={field.key} value={field.key}>
                          {field.label.ru}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field
                  label={t('admin.dataSources.feed.territoryField')}
                  htmlFor={`${id}-territory`}
                  hint={t('admin.dataSources.feed.territoryHint')}
                >
                  <Select
                    value={draft.territoryField || NONE}
                    onValueChange={(value) =>
                      onChange({ territoryField: value === NONE ? '' : value })
                    }
                  >
                    <SelectTrigger id={`${id}-territory`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>{t('admin.dataSources.feed.noField')}</SelectItem>
                      {territoryFields.map((field) => (
                        <SelectItem key={field.key} value={field.key}>
                          {field.label.ru}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              </div>
            ) : (
              <Checkbox
                label={t('admin.dataSources.feed.locate')}
                checked={locate}
                onCheckedChange={(checked) => onLocateChange(checked === true)}
              />
            )}
            <Checkbox
              label={t('admin.dataSources.feed.withinTerritory')}
              checked={draft.withinTerritory}
              onCheckedChange={(checked) => onChange({ withinTerritory: checked === true })}
            />
            <Field
              label={t('admin.dataSources.feed.bbox')}
              hint={t('admin.dataSources.feed.bboxHint')}
            >
              <div className="flex flex-wrap items-center gap-2">
                {(['west', 'south', 'east', 'north'] as const).map((side, index) => (
                  <Input
                    key={side}
                    aria-label={t(`admin.dataSources.feed.bboxSides.${side}`)}
                    placeholder={t(`admin.dataSources.feed.bboxSides.${side}`)}
                    inputMode="decimal"
                    className="h-7 w-24 text-xs"
                    value={bbox[index]}
                    onChange={(event) => setBbox(index, event.target.value)}
                  />
                ))}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    onChange({
                      bbox: TAJIKISTAN_BBOX.map(String) as [string, string, string, string],
                    })
                  }
                >
                  {t('admin.dataSources.feed.bboxCountry')}
                </Button>
              </div>
            </Field>
          </>
        ) : null}
      </div>
    </Card>
  )
}
