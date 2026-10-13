import { FeedConfig, type FeedPreview, type SourceRecord } from '@kchs/contracts'
import {
  Button,
  Callout,
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
import { ObjectPicker } from '~/entities/objects/object-picker.js'
import { datasetQuery } from '~/features/data/queries.js'
import { ApiError } from '~/shared/api/client.js'
import { integrationsQuery, spacesQuery } from '~/shared/api/queries.js'
import { useT } from '~/shared/i18n.js'
import { orderSpaces } from '~/shared/spaces.js'
import { AddressStep } from './feed-address-step.js'
import {
  configFromDraft,
  datasetFields,
  draftFromConfig,
  draftProblems,
  emptyDraft,
  emptyMapping,
  type FeedDraft,
  NEW_GEOMETRY_FIELD,
  NEW_TERRITORY_FIELD,
} from './feed-form.js'
import { LocationSection } from './feed-location.js'
import { ExistingMapping, type NewColumn, NewColumns } from './feed-mapping.js'
import { sourceApi } from './queries.js'

const STEPS = ['address', 'fields', 'schedule'] as const

function problemMessage(err: unknown, fallback: string): string {
  if (!(err instanceof ApiError)) return fallback
  const field = Object.values(err.fieldErrors())[0]
  return field && !field.includes('.') ? `${err.message}: ${field}` : err.message
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
