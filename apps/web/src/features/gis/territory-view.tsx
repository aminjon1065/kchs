import { useAppearance } from '~/app/appearance.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { TerritoryCard } from './territory-card.js'

/** Вкладка объекта-территории (`/o/{id}`): карточка, переходы — в новых вкладках. */
export function TerritoryView({ objectId }: { objectId: string }) {
  const locale = useAppearance((s) => s.locale)
  const openTab = useWorkspace((s) => s.openTab)
  return (
    <div className="h-full overflow-y-auto bg-canvas p-5">
      <div className="mx-auto max-w-[960px]">
        <TerritoryCard
          territoryId={objectId}
          locale={locale}
          onNavigate={(territory) =>
            openTab({
              kind: 'object',
              objectId: territory.id,
              objectType: 'territory',
              title: territory.name[locale] ?? territory.name.ru,
              mode: 'preview',
            })
          }
        />
      </div>
    </div>
  )
}
