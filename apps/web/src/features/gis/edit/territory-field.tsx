import type { Locale, Territory } from '@kchs/contracts'
import { Button, IconButton, Popover, PopoverContent, PopoverTrigger } from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { MapPin, X } from 'lucide-react'
import { useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { territoriesQuery } from '../queries.js'
import { TerritoryTree } from '../territory-tree.js'

const nameOf = (territory: Territory, locale: Locale) => territory.name[locale] ?? territory.name.ru

/**
 * Поле-территория формы атрибутов (07-gis-engine.md §7): дерево справочника с
 * поиском; территория по карте (обратный геокодер по точке объекта) —
 * подсказкой «подставить», если значение выбрано вручную и отличается.
 */
export function TerritoryField({
  id,
  value,
  onChange,
  invalid,
  disabled,
  suggestion,
  auto,
}: {
  id: string
  value: unknown
  onChange: (value: string | null) => void
  invalid: boolean
  disabled: boolean
  /** Единица, в которой лежит объект, — по обратному геокодеру. */
  suggestion: Territory | null
  /** Значение подставлено по карте. */
  auto: boolean
}) {
  const t = useT()
  const locale = useAppearance((s) => s.locale) as Locale
  const { data: items = [] } = useQuery(territoriesQuery())
  const [open, setOpen] = useState(false)
  const selected = typeof value === 'string' ? items.find((item) => item.id === value) : undefined
  const differs = suggestion && suggestion.id !== value
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              id={id}
              type="button"
              variant="secondary"
              disabled={disabled}
              aria-invalid={invalid || undefined}
              className="min-w-0 flex-1 justify-start"
            >
              <span className="truncate">
                {selected ? nameOf(selected, locale) : t('gis.edit.territoryNone')}
              </span>
            </Button>
          </PopoverTrigger>
          <PopoverContent className="flex h-80 w-80 flex-col">
            <TerritoryTree
              items={items}
              selectedId={selected?.id ?? null}
              onSelect={(territory) => {
                onChange(territory.id)
                setOpen(false)
              }}
              locale={locale}
            />
          </PopoverContent>
        </Popover>
        {selected && !disabled ? (
          <IconButton
            type="button"
            label={t('gis.territories.clear')}
            size="sm"
            onClick={() => onChange(null)}
          >
            <X className="size-3.5" aria-hidden />
          </IconButton>
        ) : null}
      </div>
      {auto && selected ? (
        <p className="flex items-center gap-1 text-xs text-fg-muted">
          <MapPin className="size-3" aria-hidden />
          {t('gis.edit.territoryAuto')}
        </p>
      ) : differs && !disabled ? (
        <p className="flex flex-wrap items-center gap-1 text-xs text-fg-muted">
          <MapPin className="size-3" aria-hidden />
          {t('gis.edit.territorySuggested', { name: nameOf(suggestion, locale) })}
          <Button type="button" variant="link" size="sm" onClick={() => onChange(suggestion.id)}>
            {t('gis.edit.territoryApply')}
          </Button>
        </p>
      ) : null}
    </div>
  )
}
