import {
  type FilterNode,
  METRIC_AGGREGATES,
  METRIC_COMPARISONS,
  METRIC_DIRECTIONS,
  METRIC_PERIOD_UNITS,
  METRIC_STATUSES,
  type MetricAggregate,
  type MetricComparison,
  type MetricCreateInput,
  type MetricDirection,
  type MetricPeriod,
  type MetricPeriodUnit,
  type MetricRecord,
  type MetricStatus,
} from '@kchs/contracts'
import {
  Button,
  Callout,
  Checkbox,
  Dialog,
  DialogContent,
  Field,
  FilterBuilder,
  IconButton,
  Input,
  SegmentedControl,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, X } from 'lucide-react'
import { type ReactNode, useId, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { ApiError, http } from '~/shared/api/client.js'
import { objectListQuery } from '~/shared/api/queries.js'
import { fieldLabel, filterFieldsOf, NUMERIC_TYPES } from './field-types.js'
import {
  METRIC_PERIOD_PRESETS,
  type MetricPeriodPreset,
  periodPreset,
  periodText,
  presetPeriod,
} from './metric-format.js'
import { dataKeys, datasetQuery } from './queries.js'

const DATASET_TIME = '__dataset'
/** Количество строк — мера без поля. */
const ROWS = '__rows'
const ANY_UNIT = '__any'
const CUSTOM = 'custom'
/** Разрезом не бывают геометрия и JSON. */
const NOT_DIMENSION = new Set(['geometry', 'json'])

interface TargetDraft {
  value: string
  unit: MetricPeriodUnit | typeof ANY_UNIT
}

interface ThresholdDraft {
  value: string
  status: MetricStatus
}

interface Draft {
  name: string
  description: string
  datasetId: string | null
  agg: MetricAggregate
  field: string | null
  expr: string
  filter: FilterNode | null
  timeField: string | null
  dimensions: string[]
  period: MetricPeriod | null
  comparison: MetricComparison
  unit: string
  precision: string
  direction: MetricDirection
  targets: TargetDraft[]
  thresholds: ThresholdDraft[]
}

function draftOf(metric: MetricRecord | null): Draft {
  if (!metric) {
    return {
      name: '',
      description: '',
      datasetId: null,
      agg: 'count',
      field: null,
      expr: '',
      filter: null,
      timeField: null,
      dimensions: [],
      period: { unit: 'month', from: 0, to: 0 },
      comparison: 'previous_period',
      unit: '',
      precision: '',
      direction: 'up',
      targets: [],
      thresholds: [],
    }
  }
  const { definition } = metric
  return {
    name: metric.name,
    description: metric.description ?? '',
    datasetId: metric.datasetId,
    agg: definition.measure.agg,
    field: definition.measure.field ?? null,
    expr: definition.measure.expr ?? '',
    filter: definition.filter,
    timeField: definition.timeField,
    dimensions: definition.dimensions,
    period: definition.period,
    comparison: definition.comparison,
    unit: metric.unit ?? '',
    precision: metric.format?.precision === undefined ? '' : String(metric.format.precision),
    direction: metric.direction,
    targets: metric.targets.map((target) => ({
      value: String(target.value),
      unit: target.unit ?? ANY_UNIT,
    })),
    thresholds: metric.thresholds.map((threshold) => ({
      value: String(threshold.value),
      status: threshold.status,
    })),
  }
}

const isNumber = (value: string) => value.trim() !== '' && Number.isFinite(Number(value))

function Section({
  legend,
  hint,
  children,
}: {
  legend: string
  hint?: string
  children: ReactNode
}) {
  return (
    <fieldset className="flex min-w-0 flex-col gap-2">
      <legend className="mb-1 text-xs font-medium text-fg-secondary">{legend}</legend>
      {children}
      {hint ? <p className="text-xs text-fg-muted">{hint}</p> : null}
    </fieldset>
  )
}

/**
 * Редактор показателя (06-analytics-engine.md §7): датасет → мера → условия →
 * время → формат → цели и пороги. Сервер проверяет определение компилятором
 * запросов; ошибка — в подсказке над формой.
 */
export function MetricEditor({
  spaceId,
  metric,
  onClose,
}: {
  spaceId: string
  /** null — новый показатель. */
  metric: MetricRecord | null
  onClose: () => void
}) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const locale = useAppearance((s) => s.locale)
  const openTab = useWorkspace((s) => s.openTab)
  const ids = {
    name: useId(),
    description: useId(),
    expr: useId(),
    unit: useId(),
    precision: useId(),
  }
  const [draft, setDraft] = useState<Draft>(() => draftOf(metric))
  const [failure, setFailure] = useState<string | null>(null)
  const update = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }))

  const { data: datasets } = useQuery(objectListQuery({ spaceId, types: 'dataset', limit: 100 }))
  const { data: dataset } = useQuery({
    ...datasetQuery(draft.datasetId ?? ''),
    enabled: Boolean(draft.datasetId),
  })
  const fields = dataset?.fields ?? []
  const numeric = fields.filter((field) => NUMERIC_TYPES.has(field.type))
  const temporal = fields.filter((field) => field.type === 'date' || field.type === 'datetime')
  const dimensions = fields.filter((field) => !NOT_DIMENSION.has(field.type))
  // Количество — по строкам (или непустым значениям поля), различные — по любому полю
  const targetFields = draft.agg === 'count' || draft.agg === 'count_distinct' ? fields : numeric
  const needsField = draft.agg !== 'count' && draft.agg !== 'expr'
  const hasTime = Boolean(draft.timeField ?? dataset?.timeField)

  const valid =
    draft.name.trim() !== '' &&
    draft.datasetId !== null &&
    (draft.agg === 'expr' ? draft.expr.trim() !== '' : !needsField || draft.field !== null) &&
    draft.targets.every((target) => isNumber(target.value)) &&
    draft.thresholds.every((threshold) => isNumber(threshold.value))

  const save = useMutation({
    mutationFn: async () => {
      const body: Omit<MetricCreateInput, 'spaceId'> = {
        name: draft.name.trim(),
        description: draft.description.trim() || null,
        datasetId: draft.datasetId ?? '',
        definition: {
          measure:
            draft.agg === 'expr'
              ? { agg: 'expr', expr: draft.expr.trim() }
              : { agg: draft.agg, ...(draft.field ? { field: draft.field } : {}) },
          filter: draft.filter,
          timeField: draft.timeField,
          dimensions: draft.dimensions,
          // Без поля времени значение считается только за всё время
          period: hasTime ? draft.period : null,
          comparison: draft.comparison,
        },
        unit: draft.unit.trim() || null,
        format: draft.precision === '' ? null : { precision: Number(draft.precision) },
        direction: draft.direction,
        targets: draft.targets.map((target) => ({
          value: Number(target.value),
          unit: target.unit === ANY_UNIT ? null : target.unit,
        })),
        thresholds: draft.thresholds.map((threshold) => ({
          value: Number(threshold.value),
          status: threshold.status,
        })),
      }
      if (metric) {
        await http.patch(`/metrics/${metric.id}`, body)
        return { id: metric.id }
      }
      return http.post<{ id: string }>('/metrics', { ...body, spaceId })
    },
    onSuccess: ({ id }) => {
      toast.show({
        title: t(metric ? 'data.metric.saved' : 'data.metric.created'),
        tone: 'success',
      })
      void client.invalidateQueries({ queryKey: ['objects'] })
      void client.invalidateQueries({ queryKey: dataKeys.metric(id) })
      onClose()
      if (!metric) {
        openTab({
          kind: 'object',
          objectId: id,
          objectType: 'metric',
          title: draft.name.trim(),
          mode: 'permanent',
        })
      }
    },
    onError: (error) => setFailure(error instanceof ApiError ? error.message : t('errors.unknown')),
  })

  const preset = periodPreset(draft.period)

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title={t(metric ? 'data.metric.editTitle' : 'data.metric.createTitle')}
        size="lg"
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={!valid}
              loading={save.isPending}
              onClick={() => save.mutate()}
            >
              {t(metric ? 'common.actions.save' : 'common.actions.create')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-5">
          {failure ? <Callout tone="danger">{failure}</Callout> : null}
          <div className="grid gap-3 md:grid-cols-2">
            <Field label={t('data.metric.name')} htmlFor={ids.name} required>
              <Input
                id={ids.name}
                autoFocus
                value={draft.name}
                maxLength={200}
                onChange={(event) => update({ name: event.target.value })}
              />
            </Field>
            <Field label={t('data.metric.dataset')}>
              <Select
                value={draft.datasetId ?? undefined}
                onValueChange={(datasetId) =>
                  update({ datasetId, field: null, filter: null, timeField: null, dimensions: [] })
                }
              >
                <SelectTrigger aria-label={t('data.metric.dataset')}>
                  <SelectValue placeholder={t('data.metric.pickDataset')} />
                </SelectTrigger>
                <SelectContent>
                  {(datasets?.items ?? []).map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          <Field label={t('data.metric.description')} htmlFor={ids.description}>
            <Textarea
              id={ids.description}
              rows={2}
              maxLength={1000}
              value={draft.description}
              onChange={(event) => update({ description: event.target.value })}
            />
          </Field>

          {draft.datasetId ? (
            <>
              <Section legend={t('data.metric.measure')}>
                <div className="flex flex-wrap items-center gap-2">
                  <Select
                    value={draft.agg}
                    onValueChange={(next) => {
                      const agg = next as MetricAggregate
                      const pool = agg === 'count' || agg === 'count_distinct' ? fields : numeric
                      const field = pool.some((item) => item.key === draft.field)
                        ? draft.field
                        : agg === 'count' || agg === 'expr'
                          ? null
                          : (pool[0]?.key ?? null)
                      update({ agg, field })
                    }}
                  >
                    <SelectTrigger aria-label={t('data.metric.aggregate')} className="w-44">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {METRIC_AGGREGATES.map((agg) => (
                        <SelectItem key={agg} value={agg}>
                          {t(`data.metric.aggregates.${agg}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {draft.agg === 'expr' ? null : (
                    <Select
                      value={draft.field ?? ROWS}
                      onValueChange={(field) => update({ field: field === ROWS ? null : field })}
                    >
                      <SelectTrigger
                        aria-label={t('data.metric.field')}
                        className="min-w-52 flex-1"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {draft.agg === 'count' ? (
                          <SelectItem value={ROWS}>{t('data.metric.rows')}</SelectItem>
                        ) : null}
                        {targetFields.map((field) => (
                          <SelectItem key={field.key} value={field.key}>
                            {fieldLabel(field, locale)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>
                {draft.agg === 'expr' ? (
                  <Field
                    label={t('data.metric.expression')}
                    htmlFor={ids.expr}
                    hint={t('data.metric.expressionHint')}
                  >
                    <Textarea
                      id={ids.expr}
                      rows={2}
                      className="font-mono"
                      value={draft.expr}
                      onChange={(event) => update({ expr: event.target.value })}
                    />
                  </Field>
                ) : null}
              </Section>

              <Section legend={t('data.metric.filter')} hint={t('data.metric.filterHint')}>
                <FilterBuilder
                  fields={filterFieldsOf(fields, locale)}
                  value={draft.filter}
                  onChange={(filter) => update({ filter })}
                />
              </Section>

              <div className="grid gap-3 md:grid-cols-3">
                <Field label={t('data.metric.timeField')}>
                  <Select
                    value={draft.timeField ?? DATASET_TIME}
                    onValueChange={(key) =>
                      update({ timeField: key === DATASET_TIME ? null : key })
                    }
                  >
                    <SelectTrigger aria-label={t('data.metric.timeField')}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={DATASET_TIME}>
                        {t('data.metric.timeFieldDefault')}
                      </SelectItem>
                      {temporal.map((field) => (
                        <SelectItem key={field.key} value={field.key}>
                          {fieldLabel(field, locale)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label={t('data.metric.period')}>
                  <Select
                    value={hasTime ? preset : 'all'}
                    disabled={!hasTime}
                    onValueChange={(next) =>
                      next !== CUSTOM &&
                      update({ period: presetPeriod(next as MetricPeriodPreset) })
                    }
                  >
                    <SelectTrigger aria-label={t('data.metric.period')}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {preset === CUSTOM ? (
                        <SelectItem value={CUSTOM}>
                          {periodText(draft.period, t, locale)}
                        </SelectItem>
                      ) : null}
                      {METRIC_PERIOD_PRESETS.map((item) => (
                        <SelectItem key={item} value={item}>
                          {t(`data.metric.periods.${item}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label={t('data.metric.comparison')}>
                  <Select
                    value={draft.comparison}
                    onValueChange={(next) => update({ comparison: next as MetricComparison })}
                  >
                    <SelectTrigger aria-label={t('data.metric.comparison')}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {METRIC_COMPARISONS.map((value) => (
                        <SelectItem key={value} value={value}>
                          {t(`data.metric.comparisons.${value}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              </div>
              {!hasTime ? <Callout tone="info">{t('data.metric.noTimeField')}</Callout> : null}

              {dimensions.length > 0 ? (
                <Section
                  legend={t('data.metric.dimensions')}
                  hint={t('data.metric.dimensionsHint')}
                >
                  <ul className="grid gap-1 sm:grid-cols-3">
                    {dimensions.map((field) => (
                      <li key={field.key}>
                        <label className="flex cursor-pointer items-center gap-2 rounded-xs px-1.5 py-1 text-sm hover:bg-surface-3">
                          <Checkbox
                            checked={draft.dimensions.includes(field.key)}
                            onCheckedChange={(checked) =>
                              update({
                                dimensions:
                                  checked === true
                                    ? [...draft.dimensions, field.key]
                                    : draft.dimensions.filter((key) => key !== field.key),
                              })
                            }
                          />
                          <span className="min-w-0 truncate">{fieldLabel(field, locale)}</span>
                        </label>
                      </li>
                    ))}
                  </ul>
                </Section>
              ) : null}
            </>
          ) : null}

          <div className="grid gap-3 md:grid-cols-3">
            <Field label={t('data.metric.unit')} htmlFor={ids.unit}>
              <Input
                id={ids.unit}
                value={draft.unit}
                maxLength={32}
                placeholder={t('data.metric.unitHint')}
                onChange={(event) => update({ unit: event.target.value })}
              />
            </Field>
            <Field label={t('data.metric.precision')} htmlFor={ids.precision}>
              <Input
                id={ids.precision}
                type="number"
                min={0}
                max={6}
                value={draft.precision}
                onChange={(event) => update({ precision: event.target.value })}
              />
            </Field>
            <Section legend={t('data.metric.direction')}>
              <SegmentedControl
                size="sm"
                aria-label={t('data.metric.direction')}
                value={draft.direction}
                onValueChange={(direction) => update({ direction })}
                options={METRIC_DIRECTIONS.map((value) => ({
                  value,
                  label: t(`data.metric.directions.${value}`),
                }))}
              />
            </Section>
          </div>

          <Section legend={t('data.metric.targets')} hint={t('data.metric.targetsHint')}>
            {draft.targets.map((target, index) => (
              <div key={index} className="flex items-center gap-2">
                <Input
                  type="number"
                  className="w-40"
                  aria-label={t('data.metric.targetValueLabel')}
                  value={target.value}
                  onChange={(event) =>
                    update({
                      targets: draft.targets.map((item, i) =>
                        i === index ? { ...item, value: event.target.value } : item,
                      ),
                    })
                  }
                />
                <Select
                  value={target.unit}
                  onValueChange={(unit) =>
                    update({
                      targets: draft.targets.map((item, i) =>
                        i === index ? { ...item, unit: unit as TargetDraft['unit'] } : item,
                      ),
                    })
                  }
                >
                  <SelectTrigger aria-label={t('data.metric.targetUnit')} className="w-48">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ANY_UNIT}>{t('data.metric.targetAny')}</SelectItem>
                    {METRIC_PERIOD_UNITS.map((unit) => (
                      <SelectItem key={unit} value={unit}>
                        {t(`data.metric.targetUnits.${unit}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <IconButton
                  label={t('data.metric.remove')}
                  size="sm"
                  onClick={() => update({ targets: draft.targets.filter((_, i) => i !== index) })}
                >
                  <X className="size-3.5" />
                </IconButton>
              </div>
            ))}
            <Button
              variant="ghost"
              size="sm"
              icon={<Plus className="size-3.5" />}
              className="self-start"
              onClick={() => update({ targets: [...draft.targets, { value: '', unit: ANY_UNIT }] })}
            >
              {t('data.metric.addTarget')}
            </Button>
          </Section>

          <Section legend={t('data.metric.thresholds')} hint={t('data.metric.thresholdsHint')}>
            {draft.thresholds.map((threshold, index) => (
              <div key={index} className="flex items-center gap-2">
                <Input
                  type="number"
                  className="w-40"
                  aria-label={t('data.metric.thresholdValue')}
                  value={threshold.value}
                  onChange={(event) =>
                    update({
                      thresholds: draft.thresholds.map((item, i) =>
                        i === index ? { ...item, value: event.target.value } : item,
                      ),
                    })
                  }
                />
                <Select
                  value={threshold.status}
                  onValueChange={(status) =>
                    update({
                      thresholds: draft.thresholds.map((item, i) =>
                        i === index ? { ...item, status: status as MetricStatus } : item,
                      ),
                    })
                  }
                >
                  <SelectTrigger aria-label={t('data.metric.thresholdStatus')} className="w-48">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {METRIC_STATUSES.map((status) => (
                      <SelectItem key={status} value={status}>
                        {t(`data.metric.statuses.${status}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <IconButton
                  label={t('data.metric.remove')}
                  size="sm"
                  onClick={() =>
                    update({ thresholds: draft.thresholds.filter((_, i) => i !== index) })
                  }
                >
                  <X className="size-3.5" />
                </IconButton>
              </div>
            ))}
            <Button
              variant="ghost"
              size="sm"
              icon={<Plus className="size-3.5" />}
              className="self-start"
              onClick={() =>
                update({ thresholds: [...draft.thresholds, { value: '', status: 'warning' }] })
              }
            >
              {t('data.metric.addThreshold')}
            </Button>
          </Section>
        </div>
      </DialogContent>
    </Dialog>
  )
}
