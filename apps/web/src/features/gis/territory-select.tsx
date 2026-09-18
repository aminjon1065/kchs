import { Button, IconButton, Popover, PopoverContent, PopoverTrigger } from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { territoriesQuery } from './queries.js'
import { selectedOf } from './territory-filter.js'
import { TerritoryTree } from './territory-tree.js'

/** Значение фильтра по территории: единица справочника со всеми вложенными. */
export interface TerritoryValue {
  id: string
  includeChildren: boolean
}

/**
 * Выбор территории для фильтра дашборда (ADR-0057): кнопка с названием и дерево
 * справочника с поиском; выбранная единица действует вместе с вложенными.
 */
export function TerritorySelect({
  value,
  onChange,
  label,
}: {
  value: unknown
  onChange: (value: TerritoryValue | null) => void
  label: string
}) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const { data: items = [] } = useQuery(territoriesQuery())
  const [open, setOpen] = useState(false)
  const selected = selectedOf(value)
  const current = selected ? items.find((item) => item.id === selected) : undefined
  return (
    <div className="flex items-center gap-1">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="secondary" size="sm" aria-label={label} className="w-52 justify-start">
            <span className="truncate">
              {current ? (current.name[locale] ?? current.name.ru) : t('gis.territories.all')}
            </span>
          </Button>
        </PopoverTrigger>
        <PopoverContent className="flex h-80 w-80 flex-col">
          <TerritoryTree
            items={items}
            selectedId={selected}
            onSelect={(territory) => {
              onChange({ id: territory.id, includeChildren: true })
              setOpen(false)
            }}
            locale={locale}
          />
        </PopoverContent>
      </Popover>
      {current ? (
        <IconButton label={t('gis.territories.clear')} size="sm" onClick={() => onChange(null)}>
          <X className="size-3" />
        </IconButton>
      ) : null}
    </div>
  )
}
