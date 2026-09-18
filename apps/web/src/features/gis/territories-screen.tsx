import { EmptyState, ErrorState, Skeleton } from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { territoriesQuery } from './queries.js'
import { TerritoryCard } from './territory-card.js'
import { TerritoryTree } from './territory-tree.js'

/**
 * Экран «Территории» (P1-E07 S03): дерево справочника с поиском слева,
 * карточка выбранной единицы справа. Без карты — границы появятся в фазе 2.
 */
export function TerritoriesScreen() {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const { data: items, isLoading, error, refetch } = useQuery(territoriesQuery())
  const [selected, setSelected] = useState<string | null>(null)

  if (isLoading) {
    return (
      <div className="flex gap-4 p-5">
        <Skeleton className="h-96 w-72" />
        <Skeleton className="h-96 flex-1" />
      </div>
    )
  }
  if (error || !items) return <ErrorState onRetry={() => void refetch()} />
  if (items.length === 0) return <EmptyState title={t('gis.territories.empty')} />

  // По умолчанию — корень справочника (страна)
  const current = selected ?? items.find((item) => item.parentId === null)?.id ?? null

  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(240px,320px)_minmax(0,1fr)]">
      <aside className="flex min-h-0 flex-col border-r border-line bg-surface p-3">
        <TerritoryTree
          items={items}
          selectedId={current}
          onSelect={(territory) => setSelected(territory.id)}
          locale={locale}
        />
      </aside>
      <main className="min-h-0 overflow-y-auto bg-canvas p-5">
        {current ? (
          <TerritoryCard
            territoryId={current}
            locale={locale}
            onNavigate={(territory) => setSelected(territory.id)}
          />
        ) : null}
      </main>
    </div>
  )
}
