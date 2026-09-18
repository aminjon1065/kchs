import { Plus } from 'lucide-react'
import { type KeyboardEvent, useId, useRef, useState } from 'react'
import { Tag } from '../components/data-display.js'
import { useUiT } from '../i18n/ui-locale.js'
import { cn } from '../lib/cn.js'
import { Popover, PopoverAnchor, PopoverContent } from '../primitives/overlays.js'

export interface TagItem {
  id: string
  name: string
  color?: string | null
}

export interface TagInputProps {
  value: TagItem[]
  /** Подсказки словаря по текущему вводу; запрос к серверу делает приложение. */
  suggestions?: TagItem[]
  onQueryChange?: (query: string) => void
  onAdd: (name: string) => void
  onRemove: (item: TagItem) => void
  /** Только просмотр: чипы без удаления и без поля ввода. */
  readOnly?: boolean
  disabled?: boolean
  maxLength?: number
  placeholder?: string
  'aria-label'?: string
  className?: string
}

interface Option {
  key: string
  name: string
  color?: string | null
  create: boolean
}

const fold = (text: string) => text.toLocaleLowerCase()
const clean = (text: string) => text.replace(/\s+/g, ' ').trim()

/**
 * Теги объекта: чипы и поле с подсказками (шаблон ARIA combobox).
 * ↑/↓ — выбор подсказки, Enter или запятая — назначить, Esc — закрыть список.
 * Имена сравниваются без учёта регистра, как в словаре на сервере.
 */
export function TagInput({
  value,
  suggestions = [],
  onQueryChange,
  onAdd,
  onRemove,
  readOnly,
  disabled,
  maxLength = 60,
  placeholder,
  className,
  ...props
}: TagInputProps) {
  const t = useUiT()
  const listId = useId()
  const anchorRef = useRef<HTMLDivElement>(null)
  const [draft, setDraft] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)

  const query = clean(draft)
  const assigned = new Set(value.map((tag) => fold(tag.name)))
  const matches = suggestions.filter(
    (tag) => !assigned.has(fold(tag.name)) && fold(tag.name).includes(fold(query)),
  )
  const known = assigned.has(fold(query)) || matches.some((tag) => fold(tag.name) === fold(query))
  const options: Option[] = [
    ...matches.map((tag) => ({ key: tag.id, name: tag.name, color: tag.color, create: false })),
    ...(query && !known ? [{ key: '', name: query, create: true }] : []),
  ]
  const expanded = open && options.length > 0
  const current = options[Math.min(active, options.length - 1)]
  const optionId = (index: number) => `${listId}-${index}`

  const changeDraft = (next: string) => {
    setDraft(next)
    setActive(0)
    setOpen(true)
    onQueryChange?.(clean(next))
  }

  const commit = (name: string) => {
    const tag = clean(name)
    if (!tag) return
    if (!assigned.has(fold(tag))) onAdd(tag)
    setDraft('')
    setActive(0)
    setOpen(false)
    onQueryChange?.('')
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!expanded) {
        setOpen(true)
        return
      }
      const step = event.key === 'ArrowDown' ? 1 : -1
      setActive((index) => (index + step + options.length) % options.length)
    } else if (event.key === 'Enter' || event.key === ',') {
      if (!query && event.key === 'Enter') return
      event.preventDefault()
      commit(expanded && current ? current.name : query)
    } else if (event.key === 'Escape' && expanded) {
      // Закрываем только список, а не панель вокруг поля
      event.stopPropagation()
      setOpen(false)
    }
  }

  const editable = !readOnly && !disabled

  return (
    <Popover open={expanded}>
      <PopoverAnchor asChild>
        <div
          ref={anchorRef}
          data-field={editable || undefined}
          className={cn(
            'flex min-h-[var(--control-h)] flex-wrap items-center gap-1 rounded-sm px-1 py-1',
            editable && 'border border-line-strong bg-surface focus-within:border-accent',
            disabled && 'opacity-60',
            className,
          )}
        >
          {value.map((tag) => (
            <Tag
              key={tag.id}
              color={tag.color}
              onRemove={editable ? () => onRemove(tag) : undefined}
            >
              {tag.name}
            </Tag>
          ))}
          {editable ? (
            <input
              role="combobox"
              aria-label={props['aria-label'] ?? t('ui.tagInput.label')}
              aria-expanded={expanded}
              aria-controls={expanded ? listId : undefined}
              aria-autocomplete="list"
              aria-activedescendant={
                expanded ? optionId(options.indexOf(current as Option)) : undefined
              }
              value={draft}
              maxLength={maxLength}
              placeholder={
                value.length === 0 ? (placeholder ?? t('ui.tagInput.placeholder')) : undefined
              }
              onChange={(event) => changeDraft(event.target.value)}
              onKeyDown={onKeyDown}
              onFocus={() => setOpen(true)}
              onBlur={() => setOpen(false)}
              className="h-5 min-w-24 flex-1 bg-transparent px-1 text-xs text-fg outline-none placeholder:text-fg-muted"
            />
          ) : value.length === 0 ? (
            <span className="px-1 text-xs text-fg-muted">{t('ui.tagInput.none')}</span>
          ) : null}
        </div>
      </PopoverAnchor>
      <PopoverContent
        // Фокус остаётся в поле ввода: список — продолжение combobox
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onInteractOutside={(event) => {
          if (anchorRef.current?.contains(event.target as Node)) event.preventDefault()
        }}
        className="w-(--radix-popover-trigger-width) min-w-48 p-1"
      >
        <div id={listId} role="listbox" aria-label={t('ui.tagInput.suggestions')}>
          {options.map((option, index) => (
            // biome-ignore lint/a11y/useFocusableInteractive lint/a11y/useKeyWithClickEvents: вариант выбирается с клавиатуры из поля ввода (aria-activedescendant), фокус на нём не нужен
            <div
              key={option.create ? '__create' : option.key}
              id={optionId(index)}
              role="option"
              aria-selected={option === current}
              // mousedown не уводит фокус из поля ввода
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => commit(option.name)}
              onMouseEnter={() => setActive(index)}
              className={cn(
                'flex cursor-pointer select-none items-center gap-2 rounded-xs px-2 py-1.5 text-sm',
                option === current && 'bg-surface-3',
              )}
            >
              {option.create ? (
                <>
                  <Plus className="size-3.5 shrink-0 text-fg-muted" aria-hidden />
                  <span className="truncate">{t('ui.tagInput.create', { name: option.name })}</span>
                </>
              ) : (
                <Tag color={option.color}>{option.name}</Tag>
              )}
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
