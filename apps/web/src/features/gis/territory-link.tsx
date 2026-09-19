import type { Territory } from '@kchs/contracts'
import { Button } from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { useAppearance } from '~/app/appearance.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { territoriesQuery } from './queries.js'

/** Открывает паспорт территории во вкладке (03-screens.md §11). */
export function useOpenPassport(): (territory: Pick<Territory, 'id' | 'name'>) => void {
  const locale = useAppearance((s) => s.locale)
  const openTab = useWorkspace((s) => s.openTab)
  return (territory) =>
    openTab({
      kind: 'object',
      objectId: territory.id,
      objectType: 'territory',
      title: territory.name[locale] ?? territory.name.ru,
      mode: 'permanent',
    })
}

/**
 * Территория ссылкой на её паспорт: название на языке интерфейса из справочника;
 * неизвестный идентификатор — прочерк.
 */
export function TerritoryLink({ id }: { id: string | null }) {
  const locale = useAppearance((s) => s.locale)
  const open = useOpenPassport()
  const { data: items = [] } = useQuery({ ...territoriesQuery(), enabled: Boolean(id) })
  const territory = id ? items.find((item) => item.id === id) : undefined
  if (!territory) return <>—</>
  return (
    <Button variant="link" size="sm" onClick={() => open(territory)}>
      {territory.name[locale] ?? territory.name.ru}
    </Button>
  )
}
