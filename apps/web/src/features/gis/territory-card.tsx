import type { Locale, Territory } from '@kchs/contracts'
import { formatNumber } from '@kchs/fields'
import {
  Badge,
  Breadcrumbs,
  Card,
  EmptyState,
  ErrorState,
  KeyValueList,
  ObjectIcon,
  Skeleton,
} from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { useT } from '~/app/i18n.js'
import { territoryQuery } from './queries.js'

const nameOf = (territory: Territory, locale: Locale) => territory.name[locale] ?? territory.name.ru

/**
 * Карточка территории (07-gis-engine.md §11, без карты): путь от страны,
 * уровень и вид, код, население, центроид и вложенные единицы.
 */
export function TerritoryCard({
  territoryId,
  locale,
  onNavigate,
}: {
  territoryId: string
  locale: Locale
  /** Переход к другой единице: предку из пути или вложенной. */
  onNavigate: (territory: Territory) => void
}) {
  const t = useT()
  const { data: territory, isLoading, error, refetch } = useQuery(territoryQuery(territoryId))

  if (isLoading) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-5 w-64" />
        <Skeleton className="h-8 w-80" />
        <Skeleton className="h-40 w-full" />
      </div>
    )
  }
  if (error || !territory) return <ErrorState onRetry={() => void refetch()} />

  const population = territory.attributes.population
  const items = [
    { key: 'code', label: t('gis.territories.code'), value: territory.code },
    {
      key: 'level',
      label: t('gis.territories.level'),
      value: t(`gis.territories.levels.${territory.level}`),
    },
    ...(territory.kind
      ? [{ key: 'kind', label: t('gis.territories.kind'), value: territory.kind }]
      : []),
    ...(typeof population === 'number'
      ? [
          {
            key: 'population',
            label: t('gis.territories.population'),
            value: formatNumber(population, {}, { locale }),
          },
        ]
      : []),
    ...(territory.centroid
      ? [
          {
            key: 'centroid',
            label: t('gis.territories.centroid'),
            value: `${formatNumber(territory.centroid.lat, { precision: 3 }, { locale })}, ${formatNumber(territory.centroid.lon, { precision: 3 }, { locale })}`,
          },
        ]
      : []),
    ...(territory.areaKm2 !== null
      ? [
          {
            key: 'area',
            label: t('gis.territories.area'),
            value: formatNumber(territory.areaKm2, { precision: 0 }, { locale }),
          },
        ]
      : []),
  ]

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {territory.path.length > 0 ? (
        <Breadcrumbs
          items={territory.path.map((item) => ({
            id: item.id,
            label: nameOf(item, locale),
            onClick: () => onNavigate(item),
          }))}
        />
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <ObjectIcon type="territory" className="size-5 text-fg-muted" />
        <h2 className="text-lg font-semibold text-fg">{nameOf(territory, locale)}</h2>
        <Badge size="sm">{t(`gis.territories.levels.${territory.level}`)}</Badge>
      </div>
      <Card>
        <KeyValueList items={items} />
        {!territory.hasGeometry ? (
          <p className="mt-3 text-xs text-fg-muted">{t('gis.territories.noBoundary')}</p>
        ) : null}
      </Card>
      <Card padded={false} title={t('gis.territories.children')}>
        {territory.children.length > 0 ? (
          <ul className="grid gap-1 p-2 sm:grid-cols-2">
            {territory.children.map((child) => (
              <li key={child.id}>
                <button
                  type="button"
                  onClick={() => onNavigate(child)}
                  className="flex w-full items-center justify-between gap-2 rounded-xs px-2 py-1.5 text-left text-sm hover:bg-surface-3"
                >
                  <span className="truncate text-fg">{nameOf(child, locale)}</span>
                  <span className="shrink-0 text-xs text-fg-muted">{child.code}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState compact title={t('gis.territories.noChildren')} />
        )}
      </Card>
    </div>
  )
}
