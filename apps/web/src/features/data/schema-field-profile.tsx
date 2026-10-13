import type { DatasetField, Locale } from '@kchs/contracts'
import { formatDate, formatDateTime, formatNumber, formatPercent } from '@kchs/fields'
import { Callout, Histogram, KeyValueList, ProgressBar, Skeleton } from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { useLocale } from '~/shared/appearance.js'
import { useT } from '~/shared/i18n.js'
import { NUMERIC_TYPES } from './field-types.js'
import { fieldProfileQuery } from './queries.js'
import { isForbidden } from './schema-queries.js'

/** Значение профиля текстом по типу поля: числа и даты — в локали пользователя. */
function profileValue(value: string | null, type: string, locale: Locale): string {
  if (value === null) return '—'
  if (NUMERIC_TYPES.has(type)) return formatNumber(Number(value), {}, { locale })
  if (type === 'date') return formatDate(value, { locale })
  if (type === 'datetime') return formatDateTime(value, { locale })
  return value
}

export function FieldProfileView({ datasetId, field }: { datasetId: string; field: DatasetField }) {
  const t = useT()
  const locale = useLocale()
  const { data: profile, error, isLoading } = useQuery(fieldProfileQuery(datasetId, field.key))
  const number = (value: number) => formatNumber(value, {}, { locale })

  if (isLoading) return <Skeleton className="h-32 w-full" />
  if (error || !profile) {
    const restricted = isForbidden(error)
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
