import type { DatasetField, FieldOption, Locale } from '@kchs/contracts'
import { formatDate, formatDateTime, formatNumber } from '@kchs/fields'
import { Callout, Histogram, IconButton, ProgressBar, Skeleton } from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { X } from 'lucide-react'
import type { ReactNode } from 'react'
import { useLocale } from '~/shared/appearance.js'
import { useT } from '~/shared/i18n.js'
import { NUMERIC_TYPES } from './field-types.js'
import { fieldProfileQuery } from './queries.js'
import { isForbidden } from './schema-queries.js'

/** Частых значений в полосе — столько, сколько помещается в её высоту. */
const TOP = 6

/** Граница интервала гистограммы текстом по типу поля. */
function boundLabel(value: string | null | undefined, type: string, locale: Locale): string {
  if (value === null || value === undefined) return ''
  if (NUMERIC_TYPES.has(type)) return formatNumber(Number(value), { thousands: false }, { locale })
  if (type === 'date') return formatDate(value, { locale })
  if (type === 'datetime') return formatDateTime(value, { locale })
  return value
}

/**
 * Профиль столбца под таблицей (ADR-0230, макет «Датасет»): частые значения и
 * распределение столбца активной ячейки — по профилю поля `GET /datasets/:id/fields/
 * :key/profile`, то есть по всем строкам датасета, а не по фильтру таблицы.
 */
export function ColumnProfileStrip({
  datasetId,
  field,
  options,
  onHide,
}: {
  datasetId: string
  /** Столбец активной ячейки; null — ещё не выбран. */
  field: DatasetField | null
  /** Варианты поля (справочник, территории) — подписи вместо кодов, как в таблице. */
  options?: readonly FieldOption[] | undefined
  onHide: () => void
}) {
  const t = useT()
  const locale = useLocale()
  const name = field ? (field.label[locale] ?? field.label.ru ?? field.key) : ''
  const {
    data: profile,
    error,
    isLoading,
  } = useQuery({
    ...fieldProfileQuery(datasetId, field?.key ?? ''),
    enabled: Boolean(field) && field?.type !== 'geometry',
  })
  const number = (value: number) => formatNumber(value, {}, { locale })
  const labelOf = (value: string) => {
    const option = options?.find((item) => item.value === value)
    return option ? (option.label[locale] ?? option.label.ru ?? value) : value
  }

  let body: ReactNode
  if (!field || field.type === 'geometry') {
    body = <p className="text-xs text-fg-muted">{t('data.table.profile.hint')}</p>
  } else if (isLoading) {
    body = <Skeleton className="h-24 w-full" />
  } else if (error || !profile) {
    body = (
      <Callout tone={isForbidden(error) ? 'info' : 'danger'}>
        {isForbidden(error)
          ? t('data.dataset.profile.restricted')
          : t('data.dataset.profile.failed')}
      </Callout>
    )
  } else {
    const filled = profile.rows - profile.empty
    const top = profile.top.slice(0, TOP)
    body = (
      <div className="grid min-h-0 grid-cols-1 gap-x-8 gap-y-3 @3xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        {top.length > 0 ? (
          <section
            aria-label={t('data.table.profile.top')}
            className="flex min-w-0 flex-col gap-1.5"
          >
            <h3 className="flex items-baseline justify-between gap-3 text-xs font-medium text-fg-secondary">
              {t('data.table.profile.top')}
              <span className="font-mono text-2xs uppercase tracking-wide text-fg-muted">
                {t('data.table.profile.topOf', {
                  count: number(top.length),
                  distinct: number(profile.distinct),
                })}
              </span>
            </h3>
            <ul className="flex flex-col gap-1">
              {top.map((item) => (
                <li
                  key={item.value}
                  className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)_auto] items-center gap-x-3"
                >
                  <span className="truncate text-xs text-fg">{labelOf(item.value)}</span>
                  <ProgressBar
                    value={filled > 0 ? item.count / filled : 0}
                    label={labelOf(item.value)}
                  />
                  <span className="tabular text-right font-mono text-xs text-fg-secondary">
                    {number(item.count)}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {profile.histogram.length > 0 ? (
          <section
            aria-label={t('data.table.profile.distribution')}
            className="flex min-w-0 flex-col gap-1"
          >
            <h3 className="text-xs font-medium text-fg-secondary">
              {t('data.table.profile.distribution')}
            </h3>
            <Histogram
              values={profile.histogram.map((bin) => bin.count)}
              label={t('data.table.profile.distribution')}
            />
            <div className="flex justify-between font-mono text-2xs text-fg-muted tabular">
              <span>{boundLabel(profile.histogram[0]?.from, profile.type, locale)}</span>
              <span>{boundLabel(profile.histogram.at(-1)?.to, profile.type, locale)}</span>
            </div>
          </section>
        ) : null}
      </div>
    )
  }

  return (
    <section
      aria-label={t('data.table.profile.toggle')}
      className="flex max-h-56 shrink-0 flex-col gap-2 overflow-auto border-t border-line bg-surface px-4 py-3"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="truncate text-sm font-semibold text-fg">
          {field ? t('data.table.profile.title', { name }) : t('data.table.profile.toggle')}
        </h2>
        <span className="ml-auto text-2xs text-fg-muted">
          {profile
            ? profile.sampled
              ? t('data.table.profile.sampled')
              : t('data.table.profile.wholeDataset')
            : null}
        </span>
        <IconButton label={t('data.table.profile.hide')} size="sm" onClick={onHide}>
          <X className="size-3.5" />
        </IconButton>
      </div>
      {body}
    </section>
  )
}
