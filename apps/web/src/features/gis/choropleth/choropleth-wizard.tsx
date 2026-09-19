import type { DatasetRecord, ObjectSummary } from '@kchs/contracts'
import { formatNumber } from '@kchs/fields'
import {
  Button,
  Callout,
  Dialog,
  DialogContent,
  Field,
  Input,
  ProgressBar,
  RadioGroup,
  RadioItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Stepper,
  useToast,
} from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { objectListQuery, spacesQuery } from '~/shared/api/queries.js'
import { orderSpaces } from '~/shared/spaces.js'
import { datasetQuery } from '../../data/queries.js'
import {
  type ChoroplethForm,
  choroplethParams,
  initialForm,
  stepReady,
  WIZARD_STEPS,
  withDataset,
} from './choropleth-form.js'
import { MeasureStep, SourceStep, StyleStep, TerritoriesStep } from './choropleth-steps.js'
import { type ChoroplethTarget, useChoroplethRun } from './use-choropleth-run.js'

type MapChoice = 'current' | 'new' | 'existing' | 'none'

/** Название по умолчанию: «Объекты защиты на 1 000 жителей по районам». */
function defaultName(
  form: ChoroplethForm,
  dataset: DatasetRecord | null,
  t: ReturnType<typeof useT>,
  locale: string,
): string {
  if (!dataset) return ''
  const labelOf = (key: string | null) => {
    const field = dataset.fields.find((item) => item.key === key)
    return field ? (field.label[locale as 'ru'] ?? field.label.ru) : (key ?? '')
  }
  const subject =
    form.agg === 'count'
      ? dataset.name
      : t(`gis.choropleth.subjects.${form.agg}`, {
          dataset: dataset.name,
          field: labelOf(form.measureField),
        })
  return t(`gis.choropleth.names.${form.normalize}`, {
    subject,
    per: formatNumber(form.per, {}, { locale: locale as 'ru' }),
    level: t(`gis.choropleth.levelsBy.${form.level}`),
  })
}

/**
 * Хороплет-мастер (07-gis-engine.md §11, P2-E04 S04, ADR-0077): источник →
 * территории → мера и нормализация → классы и палитра с предпросмотром →
 * результат. Создаёт анализ `choropleth`, ждёт датасет-результат, добавляет
 * слой с градуированным стилем на текущую, новую или существующую карту.
 */
export function ChoroplethWizard({
  dataset: initial,
  spaceId: initialSpace,
  currentMap,
  onClose,
}: {
  /** Датасет, с экрана которого открыт мастер. */
  dataset?: DatasetRecord
  /** Пространство анализа, датасета-результата, слоя и карты по умолчанию. */
  spaceId: string
  /** Карта-студия: слой можно поставить на текущую карту (несохранённой правкой). */
  currentMap?: { addLayer: (layerId: string) => void } | null
  onClose: () => void
}) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const toast = useToast()
  const openTab = useWorkspace((s) => s.openTab)
  const [step, setStep] = useState(0)
  const [form, setForm] = useState<ChoroplethForm>(() => initialForm(initial))
  const [names, setNames] = useState<{ analysis?: string; output?: string; layer?: string }>({})
  const [spaceId, setSpaceId] = useState(initialSpace)
  const [mapChoice, setMapChoice] = useState<MapChoice>(currentMap ? 'current' : 'new')
  const [mapName, setMapName] = useState<string | null>(null)
  const [mapId, setMapId] = useState<string | null>(null)
  const run = useChoroplethRun()

  const selected = useQuery({
    ...datasetQuery(form.datasetId ?? ''),
    enabled: Boolean(form.datasetId) && form.datasetId !== initial?.id,
  })
  const dataset = form.datasetId === initial?.id ? (initial ?? null) : (selected.data ?? null)
  const { data: spaces = [] } = useQuery(spacesQuery())
  const writable = orderSpaces(spaces).filter(
    (space) => space.id === initialSpace || (space.myRole !== null && space.myRole !== 'viewer'),
  )
  const maps = useQuery({
    ...objectListQuery({ types: 'map', limit: 50 }),
    enabled: mapChoice === 'existing',
  })

  const fallback = defaultName(form, dataset, t, locale)
  const analysisName = (names.analysis ?? fallback).trim()
  const outputName = (names.output ?? analysisName).trim()
  const layerName = (names.layer ?? analysisName).trim()
  const params = choroplethParams(form)
  const key = WIZARD_STEPS[step] ?? 'source'
  const last = step === WIZARD_STEPS.length - 1
  const busy = run.state.phase === 'analysis' || run.state.phase === 'layer'
  const target: ChoroplethTarget | null =
    mapChoice === 'current' && currentMap
      ? { kind: 'current', addLayer: currentMap.addLayer }
      : mapChoice === 'new'
        ? { kind: 'new', name: (mapName ?? analysisName).trim() }
        : mapChoice === 'existing'
          ? mapId
            ? { kind: 'existing', mapId }
            : null
          : { kind: 'none' }
  const ready =
    params !== null &&
    Boolean(analysisName && outputName && layerName) &&
    target !== null &&
    (target.kind !== 'new' || Boolean(target.name))

  const state = run.state
  // Готово: мастер закрывается и ведёт к результату
  // biome-ignore lint/correctness/useExhaustiveDependencies: реакция только на смену этапа запуска
  useEffect(() => {
    if (state.phase !== 'done') return
    if (mapChoice === 'current') {
      toast.show({ title: t('gis.choropleth.addedToMap'), tone: 'success' })
    } else {
      toast.show({ title: t('gis.choropleth.created'), tone: 'success' })
      openTab(
        state.mapId
          ? {
              kind: 'object',
              objectId: state.mapId,
              objectType: 'map',
              title: mapChoice === 'new' ? (mapName ?? analysisName) : layerName,
              mode: 'permanent',
            }
          : {
              kind: 'object',
              objectId: state.layerId,
              objectType: 'layer',
              title: layerName,
              mode: 'permanent',
            },
      )
    }
    onClose()
  }, [state])

  const create = () => {
    if (!params || !target) return
    void run.start({ params, spaceId, analysisName, outputName, layerName, target })
  }
  // Закрыть можно и во время запуска: анализ досчитается, слой — из его карточки
  const close = () => {
    if (busy) toast.show({ title: t('gis.choropleth.continues'), tone: 'info' })
    onClose()
  }
  const pick = (item: ObjectSummary) => {
    if (item.id === form.datasetId) return
    setForm((previous) => ({ ...previous, datasetId: item.id, field: null }))
  }
  // Схема выбранного датасета пришла — связь с территорией и мера по ней
  useEffect(() => {
    if (selected.data && selected.data.id === form.datasetId && form.field === null) {
      setForm((previous) => withDataset(previous, selected.data))
    }
  }, [selected.data, form.datasetId, form.field])

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent
        title={t('gis.choropleth.title')}
        size="lg"
        footer={
          <>
            <Button variant="secondary" onClick={close}>
              {busy ? t('common.actions.close') : t('common.actions.cancel')}
            </Button>
            {step > 0 ? (
              <Button variant="secondary" onClick={() => setStep(step - 1)} disabled={busy}>
                {t('gis.choropleth.back')}
              </Button>
            ) : null}
            {last ? (
              <Button variant="primary" disabled={!ready} loading={busy} onClick={create}>
                {t('gis.choropleth.create')}
              </Button>
            ) : (
              <Button
                variant="primary"
                disabled={!stepReady(key, form)}
                onClick={() => setStep(step + 1)}
              >
                {t('gis.choropleth.next')}
              </Button>
            )}
          </>
        }
      >
        <div className="flex min-w-0 flex-col gap-4">
          <Stepper
            aria-label={t('gis.choropleth.title')}
            current={step}
            steps={WIZARD_STEPS.map((item) => ({
              key: item,
              label: t(`gis.choropleth.steps.${item}`),
            }))}
            onStepClick={busy ? undefined : setStep}
          />
          {key === 'source' ? (
            <SourceStep
              form={form}
              dataset={dataset}
              loading={selected.isLoading && Boolean(form.datasetId)}
              onDataset={pick}
              onChange={setForm}
            />
          ) : null}
          {key === 'territories' ? <TerritoriesStep form={form} onChange={setForm} /> : null}
          {key === 'measure' ? (
            <MeasureStep form={form} dataset={dataset} onChange={setForm} />
          ) : null}
          {key === 'style' ? <StyleStep form={form} onChange={setForm} /> : null}
          {key === 'result' ? (
            <div className="flex flex-col gap-3">
              <Field label={t('gis.choropleth.analysisName')}>
                <Input
                  value={names.analysis ?? fallback}
                  onChange={(event) => setNames({ ...names, analysis: event.target.value })}
                  aria-label={t('gis.choropleth.analysisName')}
                />
              </Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={t('gis.choropleth.outputName')}>
                  <Input
                    value={names.output ?? analysisName}
                    onChange={(event) => setNames({ ...names, output: event.target.value })}
                    aria-label={t('gis.choropleth.outputName')}
                  />
                </Field>
                <Field label={t('gis.choropleth.layerName')}>
                  <Input
                    value={names.layer ?? analysisName}
                    onChange={(event) => setNames({ ...names, layer: event.target.value })}
                    aria-label={t('gis.choropleth.layerName')}
                  />
                </Field>
              </div>
              <Field label={t('gis.choropleth.space')}>
                <Select value={spaceId} onValueChange={setSpaceId}>
                  <SelectTrigger aria-label={t('gis.choropleth.space')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {writable.map((space) => (
                      <SelectItem key={space.id} value={space.id}>
                        {space.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <fieldset className="flex min-w-0 flex-col gap-3 rounded-md border border-line p-3">
                <legend className="px-1 text-xs font-medium text-fg-secondary">
                  {t('gis.choropleth.map')}
                </legend>
                <RadioGroup
                  value={mapChoice}
                  onValueChange={(value) => setMapChoice(value as MapChoice)}
                  className="flex flex-col gap-2"
                >
                  {currentMap ? (
                    <RadioItem value="current" label={t('gis.choropleth.maps.current')} />
                  ) : null}
                  <RadioItem value="new" label={t('gis.choropleth.maps.new')} />
                  <RadioItem value="existing" label={t('gis.choropleth.maps.existing')} />
                  <RadioItem value="none" label={t('gis.choropleth.maps.none')} />
                </RadioGroup>
                {mapChoice === 'new' ? (
                  <Field label={t('gis.choropleth.mapName')}>
                    <Input
                      value={mapName ?? analysisName}
                      onChange={(event) => setMapName(event.target.value)}
                      aria-label={t('gis.choropleth.mapName')}
                    />
                  </Field>
                ) : null}
                {mapChoice === 'existing' ? (
                  <Field label={t('gis.choropleth.chooseMap')}>
                    <Select value={mapId ?? ''} onValueChange={setMapId}>
                      <SelectTrigger aria-label={t('gis.choropleth.chooseMap')}>
                        <SelectValue placeholder={t('gis.choropleth.chooseMap')} />
                      </SelectTrigger>
                      <SelectContent>
                        {(maps.data?.items ?? []).map((item) => (
                          <SelectItem key={item.id} value={item.id}>
                            {item.title}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                ) : null}
              </fieldset>
              <p className="text-xs text-fg-muted">{t('gis.choropleth.policyNote')}</p>
              {state.phase === 'analysis' ? (
                <ProgressBar
                  value={state.progress ?? 0}
                  label={t('gis.choropleth.running.analysis')}
                  showValue={state.progress !== null}
                />
              ) : null}
              {state.phase === 'layer' ? (
                <ProgressBar value={1} label={t('gis.choropleth.running.layer')} />
              ) : null}
              {state.phase === 'analysis' || state.phase === 'layer' ? (
                <p className="text-xs text-fg-secondary" aria-live="polite">
                  {t(`gis.choropleth.running.${state.phase}`)}
                </p>
              ) : null}
              {state.phase === 'failed' ? (
                <Callout
                  tone="danger"
                  title={t('gis.choropleth.failed')}
                  action={
                    state.analysisId ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          openTab({
                            kind: 'object',
                            objectId: state.analysisId as string,
                            objectType: 'analysis',
                            title: analysisName,
                            mode: 'permanent',
                          })
                          onClose()
                        }}
                      >
                        {t('gis.choropleth.openAnalysis')}
                      </Button>
                    ) : undefined
                  }
                >
                  {state.message || t('errors.unknown')}
                </Callout>
              ) : null}
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}
