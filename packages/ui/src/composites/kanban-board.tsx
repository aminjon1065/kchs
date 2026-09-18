import {
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react'
import { useUiT } from '../i18n/ui-locale.js'
import { cn } from '../lib/cn.js'

export interface KanbanColumn {
  key: string
  title: ReactNode
  /** Всего элементов в колонке (если на доске показана часть). */
  count?: number
}

export interface KanbanBoardProps<T> {
  columns: KanbanColumn[]
  items: T[]
  getItemId: (item: T) => string
  getColumnKey: (item: T) => string
  renderCard: (item: T) => ReactNode
  onCardOpen?: (item: T) => void
  /** Перенос между колонками; отказ — вернуть false из `canMove`. */
  onMove?: (item: T, toColumn: string) => void
  /** Разрешён ли переход (например, по маршруту статусов задачи). */
  canMove?: (item: T, toColumn: string) => boolean
  'aria-label'?: string
  className?: string
}

/**
 * Доска по значению поля (03-ui/04-interaction-patterns.md §2, режим «доска»).
 * Перетаскивание мышью — нативный HTML5 DnD; с клавиатуры карточка
 * переносится Alt+← / Alt+→ в соседнюю колонку (ADR-0038).
 */
export function KanbanBoard<T>({
  columns,
  items,
  getItemId,
  getColumnKey,
  renderCard,
  onCardOpen,
  onMove,
  canMove,
  className,
  ...props
}: KanbanBoardProps<T>) {
  const t = useUiT()
  const [dragging, setDragging] = useState<string | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const rootRef = useRef<HTMLFieldSetElement>(null)
  // Карточка, перенесённая с клавиатуры: в новой колонке она монтируется заново,
  // и фокус уходил бы на body — возвращаем его, если пользователь не ушёл сам
  const refocus = useRef<string | null>(null)

  useEffect(() => {
    const id = refocus.current
    if (!id) return
    const card = rootRef.current?.querySelector<HTMLElement>(`[data-card-id="${CSS.escape(id)}"]`)
    const active = document.activeElement
    if (card && card !== active && (active === null || active === document.body)) {
      card.focus()
      refocus.current = null
    }
  })

  const byColumn = new Map<string, T[]>(columns.map((column) => [column.key, []]))
  for (const item of items) byColumn.get(getColumnKey(item))?.push(item)
  const draggedItem = dragging ? items.find((item) => getItemId(item) === dragging) : undefined

  const allowed = (item: T | undefined, column: string): boolean =>
    Boolean(item && onMove && getColumnKey(item) !== column && (canMove?.(item, column) ?? true))

  const drop = (column: string) => (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setOver(null)
    setDragging(null)
    if (draggedItem && allowed(draggedItem, column)) onMove?.(draggedItem, column)
  }

  const onCardKeyDown = (item: T) => (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' && onCardOpen) {
      event.preventDefault()
      onCardOpen(item)
      return
    }
    if (!event.altKey || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return
    const index = columns.findIndex((column) => column.key === getColumnKey(item))
    const target = columns[index + (event.key === 'ArrowRight' ? 1 : -1)]
    if (target && allowed(item, target.key)) {
      event.preventDefault()
      refocus.current = getItemId(item)
      onMove?.(item, target.key)
    }
  }

  return (
    <fieldset
      ref={rootRef}
      aria-label={props['aria-label']}
      onFocus={(event) => {
        // Фокус ушёл на другой элемент доски — перенос больше не ждёт фокуса
        if ((event.target as HTMLElement).dataset.cardId !== refocus.current) {
          refocus.current = null
        }
      }}
      // min-w-0: у fieldset по умолчанию min-inline-size: min-content — без этого доска
      // растягивается по содержимому и не прокручивается по горизонтали
      className={cn(
        'm-0 flex h-full min-h-0 min-w-0 gap-3 overflow-x-auto border-0 p-3',
        className,
      )}
    >
      {columns.map((column) => {
        const cards = byColumn.get(column.key) ?? []
        const droppable = dragging !== null && allowed(draggedItem, column.key)
        return (
          <section
            key={column.key}
            aria-label={typeof column.title === 'string' ? column.title : column.key}
            className="flex w-72 shrink-0 flex-col rounded-md bg-surface-2"
          >
            <header className="flex h-9 shrink-0 items-center justify-between gap-2 px-3">
              <span className="truncate text-xs font-semibold text-fg">{column.title}</span>
              <span className="tabular text-2xs text-fg-muted">{column.count ?? cards.length}</span>
            </header>
            {/* biome-ignore lint/a11y/noStaticElementInteractions: зона сброса для мыши; с клавиатуры карточки переносятся Alt+стрелками */}
            <div
              onDragOver={(event) => {
                if (!droppable) return
                event.preventDefault()
                setOver(column.key)
              }}
              onDragLeave={() => setOver((current) => (current === column.key ? null : current))}
              onDrop={drop(column.key)}
              className={cn(
                'flex min-h-16 flex-1 flex-col gap-2 overflow-y-auto rounded-md p-2 transition-colors',
                droppable && 'bg-accent-subtle/40',
                over === column.key && 'bg-accent-subtle ring-1 ring-accent/40',
              )}
            >
              {cards.length === 0 ? (
                <p className="py-4 text-center text-2xs text-fg-muted">{t('ui.board.empty')}</p>
              ) : (
                cards.map((item) => {
                  const id = getItemId(item)
                  return (
                    // biome-ignore lint/a11y/useSemanticElements: карточка доски — перетаскиваемый элемент с клавиатурой
                    <div
                      key={id}
                      data-card-id={id}
                      role="button"
                      tabIndex={0}
                      draggable={Boolean(onMove)}
                      aria-roledescription={t('ui.board.card')}
                      onDragStart={(event) => {
                        event.dataTransfer.effectAllowed = 'move'
                        event.dataTransfer.setData('text/plain', id)
                        setDragging(id)
                      }}
                      onDragEnd={() => {
                        setDragging(null)
                        setOver(null)
                      }}
                      onDoubleClick={() => onCardOpen?.(item)}
                      onKeyDown={onCardKeyDown(item)}
                      className={cn(
                        'cursor-pointer rounded-md border border-line bg-surface p-2.5 text-sm shadow-xs',
                        'outline-none transition-shadow hover:border-line-strong focus-visible:ring-2 focus-visible:ring-accent/50',
                        dragging === id && 'opacity-50',
                      )}
                    >
                      {renderCard(item)}
                    </div>
                  )
                })
              )}
            </div>
          </section>
        )
      })}
    </fieldset>
  )
}
