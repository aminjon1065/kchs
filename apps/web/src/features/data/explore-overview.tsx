import type { DatasetField, DatasetRecord, FieldProfile } from '@kchs/contracts'
import { formatDate, formatDateTime, formatNumber, formatPercent } from '@kchs/fields'
import { Button, Histogram, ProgressBar, Skeleton } from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import {
  CalendarRange,
  ChartColumn,
  ChartLine,
  Map as MapIcon,
  MapPin,
  Sigma,
  SlidersHorizontal,
  TrendingUp,
} from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { optionLabels } from '~/features/gis/index.js'
import { useLocale } from '~/shared/appearance.js'
import { useT } from '~/shared/i18n.js'
import { labelOf } from './explore-builder.js'
import {
  analysisFields,
  type ExploreQuestion,
  exploreQuestions,
  type FieldKind,
  fieldKind,
  fieldQuestionPlan,
  timeFieldOf,
} from './explore-insights.js'
import { overviewProfileQuery } from './explore-queries.js'
import { useFieldOptions } from './field-options.js'

/**
 * Обзор датасета — первый вид «Исследования» (ADR-0217): вместо одинокого числа
 * аналитик видит, что в данных есть, и начинает с готового вопроса. Шапка — объём,
 * период, заполненность и свежесть; ниже — вопросы из схемы и карточки полей с
 * мини-профилем (профили грузятся, когда карточка видна, не больше трёх сразу).
 */

function useProfile(datasetId: string, key: string, enabled: boolean) {
  return useQuery(overviewProfileQuery(datasetId, key, enabled))
}

/** Карточка видна на экране — с этого момента и навсегда (без наблюдателя — сразу). */
function useSeen<T extends Element>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T>(null)
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === 'undefined')
  useEffect(() => {
    if (seen || !ref.current) return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setSeen(true)
    })
    observer.observe(ref.current)
    return () => observer.disconnect()
  }, [seen])
  return [ref, seen]
}

/**
 * Границы данных по полю времени: период в шапке и якорь пресетов сравнения —
 * последняя дата в данных, а не сегодняшний день.
 */
export function useDataRange(dataset: DatasetRecord | undefined): {
  min: string | null
  max: string | null
} {
  const time = dataset ? timeFieldOf(dataset) : null
  const { data } = useProfile(dataset?.id ?? '', time?.key ?? '', Boolean(dataset && time))
  return { min: data?.min ?? null, max: data?.max ?? null }
}

const QUESTION_ICONS: Record<string, ReactNode> = {
  trend: <ChartLine className="size-4" aria-hidden />,
  top: <ChartColumn className="size-4" aria-hidden />,
  territory: <MapPin className="size-4" aria-hidden />,
  map: <MapIcon className="size-4" aria-hidden />,
  compare: <CalendarRange className="size-4" aria-hidden />,
  sum: <Sigma className="size-4" aria-hidden />,
}

export function ExploreOverview({
  dataset,
  range,
  onPick,
  onOwn,
}: {
  dataset: DatasetRecord
  range: { min: string | null; max: string | null }
  onPick: (question: Pick<ExploreQuestion, 'plan' | 'view' | 'chartType'>) => void
  onOwn: () => void
}) {
  const t = useT()
  const locale = useLocale()
  const fields = useMemo(() => analysisFields(dataset.fields), [dataset.fields])
  const label = (field: DatasetField) => labelOf(field, locale)
  const questions = exploreQuestions(dataset, label, range.max?.slice(0, 10) ?? null)
  // Заполненность — по загруженным профилям полей: доля непустых значений
  const [filled, setFilled] = useState<ReadonlyMap<string, number>>(new Map())
  const filledShare =
    filled.size > 0
      ? [...filled.values()].reduce((sum, value) => sum + value, 0) / filled.size
      : null
  const number = (value: number) => formatNumber(value, {}, { locale })
  const day = (value: string) => formatDate(value, { locale })

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-4">
      <section aria-label={t('data.explore.overview')} className="flex flex-col gap-3">
        <h2 className="text-base font-semibold text-fg">{t('data.explore.overview')}</h2>
        <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label={t('data.explore.stats.rows')} value={number(dataset.rowCount)} />
          <Stat label={t('data.explore.stats.fields')} value={number(fields.length)} />
          <Stat
            label={t('data.explore.stats.period')}
            value={range.min && range.max ? `${day(range.min)} — ${day(range.max)}` : '—'}
          />
          <Stat
            label={t('data.explore.stats.filled')}
            value={filledShare === null ? '—' : formatPercent(filledShare, {}, { locale })}
          />
        </dl>
        <p className="text-xs text-fg-muted">
          {t('data.explore.stats.updated')}:{' '}
          {formatDateTime(dataset.lastImportAt ?? dataset.updatedAt, { locale })} ·{' '}
          {t('data.explore.stats.version', { version: dataset.currentVersion })}
        </p>
      </section>

      <section aria-label={t('data.explore.questionsTitle')} className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-fg">{t('data.explore.questionsTitle')}</h2>
          <Button
            size="sm"
            variant="secondary"
            icon={<SlidersHorizontal className="size-3.5" />}
            onClick={onOwn}
          >
            {t('data.explore.own')}
          </Button>
        </div>
        <ul className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
          {questions.map((question) => (
            <li key={question.id}>
              <button
                type="button"
                onClick={() => onPick(question)}
                className="flex w-full items-center gap-3 rounded-md border border-line bg-surface px-3 py-2.5 text-left text-sm text-fg hover:border-line-strong hover:bg-surface-2 outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
              >
                <span className="text-accent">
                  {QUESTION_ICONS[question.id.split(':')[0] as string] ?? (
                    <TrendingUp className="size-4" aria-hidden />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  {t(question.title.key, question.title.params)}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <p className="text-xs text-fg-muted">{t('data.explore.ownHint')}</p>
      </section>

      <section aria-label={t('data.explore.fieldsTitle')} className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-fg">{t('data.explore.fieldsTitle')}</h2>
        <ul className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
          {fields.map((field) => (
            <li key={field.key}>
              <FieldCard
                datasetId={dataset.id}
                field={field}
                fields={fields}
                onPick={() =>
                  onPick({
                    plan: fieldQuestionPlan(dataset, field),
                    view: 'chart',
                    chartType: null,
                  })
                }
                onFilled={(share) =>
                  setFilled((current) =>
                    current.get(field.key) === share
                      ? current
                      : new Map(current).set(field.key, share),
                  )
                }
              />
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-md border border-line bg-surface px-3 py-2">
      <dt className="text-2xs text-fg-muted">{label}</dt>
      <dd className="tabular text-base font-semibold text-fg">{value}</dd>
    </div>
  )
}

/** Значение профиля текстом: числа и даты — по формату поля, справочные — подписью. */
function profileText(
  value: string | null,
  kind: FieldKind,
  locale: 'ru' | 'tg' | 'en',
  labels: ReadonlyMap<string, string> | undefined,
): string {
  if (value === null) return '—'
  if (kind === 'number') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? formatNumber(parsed, {}, { locale }) : value
  }
  if (kind === 'time') return formatDate(value, { locale })
  return labels?.get(value) ?? value
}

function FieldCard({
  datasetId,
  field,
  fields,
  onPick,
  onFilled,
}: {
  datasetId: string
  field: DatasetField
  fields: readonly DatasetField[]
  onPick: () => void
  onFilled: (share: number) => void
}) {
  const t = useT()
  const locale = useLocale()
  const [ref, seen] = useSeen<HTMLButtonElement>()
  const kind = fieldKind(field)
  const { data: profile, isLoading, error } = useProfile(datasetId, field.key, seen)
  const options = useFieldOptions(fields)
  const labels = useMemo(() => {
    const list = options.get(field.key)
    return list ? optionLabels(list, locale) : undefined
  }, [options, field.key, locale])
  const name = labelOf(field, locale)

  useEffect(() => {
    if (profile && profile.rows > 0) onFilled((profile.rows - profile.empty) / profile.rows)
  }, [profile, onFilled])

  return (
    <button
      ref={ref}
      type="button"
      onClick={onPick}
      aria-label={t('data.explore.field.explore', { field: name })}
      className="flex w-full flex-col gap-2 rounded-md border border-line bg-surface p-3 text-left hover:border-line-strong hover:bg-surface-2 outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
    >
      <span className="flex items-baseline justify-between gap-2">
        <span className="truncate text-sm font-medium text-fg">{name}</span>
        {profile && profile.rows > 0 ? (
          <span className="shrink-0 text-2xs text-fg-muted tabular">
            {t('data.explore.field.empty', {
              share: formatPercent(profile.empty / profile.rows, {}, { locale }),
            })}
          </span>
        ) : null}
      </span>
      {!seen || isLoading ? (
        <Skeleton className="h-12 w-full" />
      ) : error || !profile ? (
        <span className="text-xs text-fg-muted">{t('data.explore.field.noProfile')}</span>
      ) : (
        <ProfileSummary profile={profile} kind={kind} labels={labels} name={name} />
      )}
    </button>
  )
}

function ProfileSummary({
  profile,
  kind,
  labels,
  name,
}: {
  profile: FieldProfile
  kind: FieldKind
  labels: ReadonlyMap<string, string> | undefined
  name: string
}) {
  const t = useT()
  const locale = useLocale()
  const text = (value: string | null) => profileText(value, kind, locale, labels)
  if (kind === 'geometry') {
    return (
      <span className="text-xs text-fg-secondary">
        {t('data.explore.field.geometry', {
          types: profile.top.map((item) => item.value).join(', ') || '—',
        })}
      </span>
    )
  }
  if ((kind === 'number' || kind === 'time') && profile.histogram.length > 0) {
    return (
      <span className="flex flex-col gap-1">
        <Histogram values={profile.histogram.map((bin) => bin.count)} label={name} />
        <span className="flex justify-between gap-2 text-2xs text-fg-muted tabular">
          <span>{text(profile.min)}</span>
          {kind === 'number' && profile.mean !== null ? (
            <span>
              {t('data.explore.field.mean', {
                value: formatNumber(profile.mean, {}, { locale }),
              })}
            </span>
          ) : null}
          <span>{text(profile.max)}</span>
        </span>
      </span>
    )
  }
  const filled = profile.rows - profile.empty
  const top = profile.top.slice(0, 4)
  return (
    <span className="flex flex-col gap-1.5">
      {top.map((item) => (
        <span key={item.value} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2">
          <span className="truncate text-xs text-fg">{text(item.value)}</span>
          <span className="text-2xs text-fg-secondary tabular">
            {formatPercent(filled > 0 ? item.count / filled : 0, {}, { locale })}
          </span>
          <ProgressBar
            value={filled > 0 ? item.count / filled : 0}
            className="col-span-2"
            label={text(item.value)}
          />
        </span>
      ))}
      <span className="text-2xs text-fg-muted">
        {t('data.explore.field.distinct', {
          count: formatNumber(profile.distinct, {}, { locale }),
        })}
      </span>
    </span>
  )
}
