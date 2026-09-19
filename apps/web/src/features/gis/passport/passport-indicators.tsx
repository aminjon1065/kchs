import type { NumberTileModel } from '@kchs/chart-spec'
import type {
  Locale,
  PassportDataset,
  PassportPeriod,
  PassportTasks,
  TerritoryPassport,
} from '@kchs/contracts'
import { formatNumber, formatPercent } from '@kchs/fields'
import { Callout, KeyValueList, NumberTile, Skeleton, StatTile } from '@kchs/ui'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { metricTileModel } from '../../data/metric-format.js'

type Translate = ReturnType<typeof useT>

/**
 * Показатель датасета плиткой: строки за период, изменение к предыдущему
 * периоду (нейтрально: рост строк не хорош и не плох сам по себе) и искра по
 * месяцам. Без поля времени — строки за всё время, без сравнения.
 */
export function datasetTileModel(
  dataset: PassportDataset,
  period: PassportPeriod,
  t: Translate,
  locale: Locale,
): NumberTileModel {
  const rows = dataset.rows
  const previous = dataset.previousRows
  let delta: NumberTileModel['delta'] = null
  if (rows !== null && previous !== null) {
    const diff = rows - previous
    const direction = diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat'
    const sign = diff > 0 ? '+' : diff < 0 ? '−' : ''
    delta = {
      value: previous > 0 ? diff / previous : diff,
      formatted:
        previous > 0
          ? `${sign}${formatPercent(Math.abs(diff / previous), { precision: 1 }, { locale })}`
          : `${sign}${formatNumber(Math.abs(diff), {}, { locale })}`,
      direction,
      good: null,
      label: t(`gis.passport.compare.${period}`),
    }
  }
  return {
    label: dataset.name,
    value: rows,
    formatted: rows === null ? '—' : formatNumber(rows, {}, { locale }),
    unit: rows === null ? null : t('gis.passport.rowsUnit', { count: rows }),
    delta,
    target: null,
    status: null,
    spark: dataset.series.map((point) => point.rows),
  }
}

/** Карточка датасета в сетке показателей: строки и суммы мер за период. */
function DatasetIndicator({
  dataset,
  period,
  onOpen,
}: {
  dataset: PassportDataset
  period: PassportPeriod
  onOpen: (dataset: PassportDataset) => void
}) {
  const t = useT()
  const locale = useAppearance((s) => s.locale) as Locale
  const measures = dataset.measures.filter((measure) => measure.value !== null)
  return (
    <article aria-label={dataset.name} className="flex min-w-0 flex-col gap-2">
      <NumberTile
        model={datasetTileModel(dataset, dataset.timeField ? period : 'all', t, locale)}
        onClick={() => onOpen(dataset)}
      />
      {dataset.error ? <Callout tone="warning">{dataset.error}</Callout> : null}
      {measures.length > 0 ? (
        <div className="rounded-md border border-line bg-surface px-3 py-2">
          <KeyValueList
            items={measures.map((measure) => ({
              key: measure.key,
              label: t('gis.passport.sumOf', {
                field: measure.label[locale] ?? measure.label.ru,
              }),
              value: formatNumber(measure.value as number, measure.format ?? {}, { locale }),
            }))}
          />
        </div>
      ) : null}
    </article>
  )
}

/**
 * Сетка показателей паспорта (03-screens.md §11): датасеты с полем территории,
 * привязанные показатели (связь `about_territory`) и поручения по территории.
 */
export function PassportIndicators({
  passport,
  loading,
  onOpenDataset,
  onOpenTasks,
}: {
  passport: TerritoryPassport | undefined
  loading: boolean
  onOpenDataset: (dataset: PassportDataset) => void
  onOpenTasks: () => void
}) {
  const t = useT()
  const locale = useAppearance((s) => s.locale) as Locale
  if (loading || !passport) {
    return (
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {['a', 'b', 'c', 'd'].map((key) => (
          <Skeleton key={key} className="h-28 w-full" />
        ))}
      </div>
    )
  }
  const tasks: PassportTasks = passport.tasks
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {passport.datasets.map((dataset) => (
          <DatasetIndicator
            key={dataset.id}
            dataset={dataset}
            period={passport.period}
            onOpen={onOpenDataset}
          />
        ))}
        {passport.metrics.map((metric) => (
          <NumberTile key={metric.metricId} model={metricTileModel(metric, t, locale)} />
        ))}
        <StatTile
          label={t('gis.passport.tasksOpen')}
          value={formatNumber(tasks.open, {}, { locale })}
          unit={
            tasks.overdue > 0 ? t('gis.passport.tasksOverdue', { count: tasks.overdue }) : undefined
          }
          onClick={onOpenTasks}
        />
      </div>
      {passport.datasets.length === 0 ? (
        <p className="text-sm text-fg-muted">{t('gis.passport.noDatasets')}</p>
      ) : null}
    </div>
  )
}
