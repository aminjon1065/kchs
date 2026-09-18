import type { Locale, Territory } from '@kchs/contracts'
import { cn, IconButton, SearchInput } from '@kchs/ui'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useT } from '~/app/i18n.js'

/** Название без регистра, «ё» как «е» — как сопоставляет сервер. */
// i18n-ignore: буква для сопоставления, не текст интерфейса
const normalize = (value: string) => value.trim().toLowerCase().replace(/ё/g, 'е')

const nameOf = (territory: Territory, locale: Locale) => territory.name[locale] ?? territory.name.ru

/**
 * Дерево справочника территорий с поиском (07-gis-engine.md §11): вложенные
 * списки с кнопками раскрытия; поиск по названию на любом языке и коду
 * показывает совпадения плоским списком с путём от региона.
 */
export function TerritoryTree({
  items,
  selectedId,
  onSelect,
  locale,
}: {
  items: readonly Territory[]
  selectedId: string | null
  onSelect: (territory: Territory) => void
  locale: Locale
}) {
  const t = useT()
  const [query, setQuery] = useState('')
  const { byId, children, roots } = useMemo(() => {
    const byId = new Map(items.map((item) => [item.id, item]))
    const children = new Map<string, Territory[]>()
    const roots: Territory[] = []
    for (const item of items) {
      if (item.parentId && byId.has(item.parentId)) {
        const list = children.get(item.parentId) ?? []
        list.push(item)
        children.set(item.parentId, list)
      } else roots.push(item)
    }
    const byName = (a: Territory, b: Territory) =>
      nameOf(a, locale).localeCompare(nameOf(b, locale), locale)
    for (const list of children.values()) list.sort(byName)
    roots.sort(byName)
    return { byId, children, roots }
  }, [items, locale])

  // Раскрыты корни и путь к выбранной единице
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const open = new Set(roots.map((root) => root.id))
    let current = selectedId ? byId.get(selectedId) : undefined
    while (current?.parentId) {
      open.add(current.parentId)
      current = byId.get(current.parentId)
    }
    return open
  })
  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const pathOf = (territory: Territory): string => {
    const names: string[] = []
    let parent = territory.parentId ? byId.get(territory.parentId) : undefined
    // Страну в путь не пишем: она у всех одна
    while (parent?.parentId) {
      names.unshift(nameOf(parent, locale))
      parent = parent.parentId ? byId.get(parent.parentId) : undefined
    }
    return names.join(' › ')
  }

  const needle = normalize(query)
  const matches = needle
    ? items
        .filter(
          (item) =>
            normalize(item.code).includes(needle) ||
            [item.name.ru, item.name.tg, item.name.en].some(
              (name) => name && normalize(name).includes(needle),
            ),
        )
        .slice(0, 50)
    : []

  const row = (territory: Territory) => {
    const kids = children.get(territory.id) ?? []
    const open = expanded.has(territory.id)
    const name = nameOf(territory, locale)
    return (
      <li key={territory.id}>
        <div
          className={cn(
            'flex items-center gap-1 rounded-xs pr-1',
            territory.id === selectedId && 'bg-accent-subtle',
          )}
        >
          {kids.length > 0 ? (
            <IconButton
              label={t(open ? 'gis.territories.collapse' : 'gis.territories.expand', { name })}
              size="sm"
              aria-expanded={open}
              onClick={() => toggle(territory.id)}
            >
              {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
            </IconButton>
          ) : (
            <span className="size-7 shrink-0" aria-hidden />
          )}
          <button
            type="button"
            aria-current={territory.id === selectedId ? 'true' : undefined}
            onClick={() => onSelect(territory)}
            className="min-w-0 flex-1 truncate py-1 text-left text-sm text-fg hover:text-accent"
          >
            {name}
          </button>
        </div>
        {open && kids.length > 0 ? <ul className="pl-4">{kids.map((kid) => row(kid))}</ul> : null}
      </li>
    )
  }

  return (
    <div className="flex min-h-0 flex-col gap-2">
      <SearchInput
        value={query}
        onValueChange={setQuery}
        placeholder={t('gis.territories.search')}
        aria-label={t('gis.territories.search')}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {needle ? (
          matches.length > 0 ? (
            <ul aria-label={t('gis.territories.results')}>
              {matches.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    aria-current={item.id === selectedId ? 'true' : undefined}
                    onClick={() => onSelect(item)}
                    className={cn(
                      'flex w-full flex-col rounded-xs px-2 py-1 text-left hover:bg-surface-3',
                      item.id === selectedId && 'bg-accent-subtle',
                    )}
                  >
                    <span className="truncate text-sm text-fg">{nameOf(item, locale)}</span>
                    <span className="truncate text-xs text-fg-muted">
                      {[item.code, pathOf(item)].filter(Boolean).join(' · ')}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-2 py-1 text-sm text-fg-muted">{t('gis.territories.nothingFound')}</p>
          )
        ) : (
          <ul aria-label={t('gis.territories.title')}>{roots.map((root) => row(root))}</ul>
        )}
      </div>
    </div>
  )
}
