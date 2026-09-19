import type {
  ChoroplethAggregate,
  ChoroplethLevel,
  ChoroplethMethod,
  ChoroplethNormalization,
  DatasetField,
  DatasetRecord,
  ObjectSummary,
  StylePaletteName,
} from '@kchs/contracts'
import { formatNumber } from '@kchs/fields'
import {
  Callout,
  Checkbox,
  cn,
  EmptyState,
  Field,
  Input,
  ObjectIcon,
  RadioGroup,
  RadioItem,
  SegmentedControl,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
} from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { Search } from 'lucide-react'
import { useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { objectListQuery } from '~/shared/api/queries.js'
import { TerritorySelect } from '../territory-select.js'
import {
  type ChoroplethForm,
  choroplethParams,
  choroplethReady,
  PER_OPTIONS,
  sourceFields,
  WIZARD_LEVELS,
  WIZARD_METHODS,
  WIZARD_PALETTES,
  withMeasure,
  withNormalize,
} from './choropleth-form.js'
import { ChoroplethPreview } from './choropleth-preview.js'

type Change = (next: ChoroplethForm) => void

function useLabel() {
  const locale = useAppearance((s) => s.locale)
  return (field: DatasetField) => field.label[locale] ?? field.label.ru ?? field.key
}

function FieldSelect({
  label,
  value,
  fields,
  onChange,
}: {
  label: string
  value: string | null
  fields: readonly DatasetField[]
  onChange: (key: string) => void
}) {
  const labelOf = useLabel()
  return (
    <Field label={label}>
      <Select value={value ?? ''} onValueChange={onChange}>
        <SelectTrigger aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {fields.map((field) => (
            <SelectItem key={field.key} value={field.key}>
              {labelOf(field)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  )
}

/** Шаг 1: датасет-источник и связь строк с территориями. */
export function SourceStep({
  form,
  dataset,
  loading,
  onDataset,
  onChange,
}: {
  form: ChoroplethForm
  dataset: DatasetRecord | null
  loading: boolean
  onDataset: (item: ObjectSummary) => void
  onChange: Change
}) {
  const t = useT()
  const labelOf = useLabel()
  const [search, setSearch] = useState('')
  const datasets = useQuery(
    objectListQuery({ types: 'dataset', q: search.trim() || undefined, limit: 30 }),
  )
  const { geometry, territory } = sourceFields(dataset)
  const fieldsOf = form.join === 'geometry' ? geometry : territory
  const current = fieldsOf.find((field) => field.key === form.field)

  return (
    <div className="flex flex-col gap-3">
      <Input
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder={t('gis.choropleth.findDataset')}
        aria-label={t('gis.choropleth.findDataset')}
        prefix={<Search className="size-4" />}
      />
      <ul
        className="flex max-h-44 flex-col overflow-y-auto rounded-md border border-line"
        aria-label={t('gis.choropleth.datasets')}
      >
        {datasets.isLoading ? (
          <li className="p-2">
            <Skeleton className="h-6 w-full" />
          </li>
        ) : (datasets.data?.items ?? []).length === 0 ? (
          <li>
            <EmptyState compact title={t('gis.choropleth.noDatasets')} />
          </li>
        ) : (
          (datasets.data?.items ?? []).map((item) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => onDataset(item)}
                aria-pressed={item.id === form.datasetId}
                className={cn(
                  'flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left text-sm hover:bg-surface-2',
                  item.id === form.datasetId && 'bg-accent-subtle text-accent',
                )}
              >
                <ObjectIcon type="dataset" className="size-4 shrink-0 text-fg-muted" />
                <span className="min-w-0 flex-1 truncate">{item.title}</span>
                {item.spaceName ? (
                  <span className="shrink-0 truncate text-xs text-fg-muted">{item.spaceName}</span>
                ) : null}
              </button>
            </li>
          ))
        )}
      </ul>
      {loading ? <Skeleton className="h-16 w-full" /> : null}
      {dataset && !choroplethReady(dataset) ? (
        <Callout tone="warning">{t('gis.choropleth.notSuitable')}</Callout>
      ) : null}
      {dataset && choroplethReady(dataset) ? (
        <fieldset className="flex min-w-0 flex-col gap-3 rounded-md border border-line p-3">
          <legend className="px-1 text-xs font-medium text-fg-secondary">
            {t('gis.choropleth.join')}
          </legend>
          <RadioGroup
            value={form.join}
            onValueChange={(value) => {
              const join = value as ChoroplethForm['join']
              const fields = join === 'geometry' ? geometry : territory
              onChange({ ...form, join, field: fields[0]?.key ?? null })
            }}
            className="flex flex-col gap-2"
          >
            <RadioItem
              value="territory"
              disabled={territory.length === 0}
              label={t('gis.choropleth.joins.territory')}
            />
            <RadioItem
              value="geometry"
              disabled={geometry.length === 0}
              label={t('gis.choropleth.joins.geometry')}
            />
          </RadioGroup>
          {fieldsOf.length > 1 ? (
            <FieldSelect
              label={t('gis.choropleth.field')}
              value={form.field}
              fields={fieldsOf}
              onChange={(field) => onChange({ ...form, field })}
            />
          ) : null}
          {current ? (
            <p className="text-xs text-fg-muted">
              {t(`gis.choropleth.joinHints.${form.join}`, { field: labelOf(current) })}
            </p>
          ) : null}
        </fieldset>
      ) : null}
    </div>
  )
}

/** Шаг 2: уровень территорий и, по желанию, единица, внутри которой они лежат. */
export function TerritoriesStep({ form, onChange }: { form: ChoroplethForm; onChange: Change }) {
  const t = useT()
  return (
    <div className="flex flex-col gap-3">
      <Field label={t('gis.choropleth.level')}>
        <SegmentedControl
          aria-label={t('gis.choropleth.level')}
          value={form.level}
          onValueChange={(level: ChoroplethLevel) => onChange({ ...form, level })}
          options={WIZARD_LEVELS.map((level) => ({
            value: level,
            label: t(`gis.choropleth.levels.${level}`),
          }))}
        />
      </Field>
      <Field label={t('gis.choropleth.within')} hint={t('gis.choropleth.withinHint')}>
        <TerritorySelect
          value={form.withinId ? { id: form.withinId } : null}
          onChange={(value) => onChange({ ...form, withinId: value?.id ?? null })}
          label={t('gis.choropleth.within')}
        />
      </Field>
    </div>
  )
}

/** Шаг 3: мера по территории и нормализация на население или площадь. */
export function MeasureStep({
  form,
  dataset,
  onChange,
}: {
  form: ChoroplethForm
  dataset: DatasetRecord | null
  onChange: Change
}) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const { numeric } = sourceFields(dataset)
  const normalizations: ChoroplethNormalization[] = ['none', 'population', 'area']
  return (
    <div className="flex flex-col gap-3">
      <Field label={t('gis.choropleth.measure')}>
        <SegmentedControl
          aria-label={t('gis.choropleth.measure')}
          value={form.agg}
          onValueChange={(agg: ChoroplethAggregate) => onChange(withMeasure(form, agg, numeric))}
          options={(['count', 'sum', 'avg'] as const).map((agg) => ({
            value: agg,
            label: t(`gis.choropleth.aggs.${agg}`),
          }))}
        />
      </Field>
      {form.agg !== 'count' ? (
        numeric.length > 0 ? (
          <FieldSelect
            label={t('gis.choropleth.measureField')}
            value={form.measureField}
            fields={numeric}
            onChange={(measureField) => onChange({ ...form, measureField })}
          />
        ) : (
          <Callout tone="warning">{t('gis.choropleth.noNumeric')}</Callout>
        )
      ) : null}
      <fieldset className="flex min-w-0 flex-col gap-3 rounded-md border border-line p-3">
        <legend className="px-1 text-xs font-medium text-fg-secondary">
          {t('gis.choropleth.normalize')}
        </legend>
        <RadioGroup
          value={form.normalize}
          onValueChange={(value) => onChange(withNormalize(form, value as ChoroplethNormalization))}
          className="flex flex-col gap-2"
        >
          {normalizations.map((value) => (
            <RadioItem
              key={value}
              value={value}
              disabled={form.agg === 'avg' && value !== 'none'}
              label={t(`gis.choropleth.normalizations.${value}`)}
            />
          ))}
        </RadioGroup>
        {form.normalize !== 'none' ? (
          <Field label={t('gis.choropleth.perLabel')}>
            <Select
              value={String(form.per)}
              onValueChange={(value) => onChange({ ...form, per: Number(value) })}
            >
              <SelectTrigger aria-label={t('gis.choropleth.perLabel')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PER_OPTIONS[form.normalize].map((per) => (
                  <SelectItem key={per} value={String(per)}>
                    {t(`gis.choropleth.per.${form.normalize}`, {
                      n: formatNumber(per, {}, { locale }),
                    })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        ) : null}
        <p className="text-xs text-fg-muted">
          {form.agg === 'avg'
            ? t('gis.choropleth.avgNoNormalize')
            : t(`gis.choropleth.normalizeHints.${form.normalize}`)}
        </p>
      </fieldset>
    </div>
  )
}

/** Шаг 4: классификация и палитра — с предпросмотром по данным с правами смотрящего. */
export function StyleStep({ form, onChange }: { form: ChoroplethForm; onChange: Change }) {
  const t = useT()
  const params = choroplethParams(form)
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label={t('gis.choropleth.method')}>
          <Select
            value={form.method}
            onValueChange={(method) => onChange({ ...form, method: method as ChoroplethMethod })}
          >
            <SelectTrigger aria-label={t('gis.choropleth.method')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {WIZARD_METHODS.map((method) => (
                <SelectItem key={method} value={method}>
                  {t(`gis.choropleth.methods.${method}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label={t('gis.choropleth.classes')}>
          <Select
            value={String(form.classes)}
            onValueChange={(value) => onChange({ ...form, classes: Number(value) })}
          >
            <SelectTrigger aria-label={t('gis.choropleth.classes')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[3, 4, 5, 6, 7, 8, 9].map((classes) => (
                <SelectItem key={classes} value={String(classes)}>
                  {String(classes)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label={t('gis.choropleth.palette')}>
          <Select
            value={form.palette}
            onValueChange={(palette) => onChange({ ...form, palette: palette as StylePaletteName })}
          >
            <SelectTrigger aria-label={t('gis.choropleth.palette')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {WIZARD_PALETTES.map((palette) => (
                <SelectItem key={palette} value={palette}>
                  {t(`gis.choropleth.palettes.${palette}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>
      <Checkbox
        checked={form.reverse}
        onCheckedChange={(value) => onChange({ ...form, reverse: value === true })}
        label={t('gis.choropleth.reverse')}
      />
      {params ? <ChoroplethPreview params={params} /> : null}
    </div>
  )
}
