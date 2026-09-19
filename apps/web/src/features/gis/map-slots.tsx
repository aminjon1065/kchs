import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useState,
  useSyncExternalStore,
} from 'react'

/** Живых карт (WebGL-контекстов) на экран дашборда или тетради — не больше. */
export const LIVE_MAPS = 4

/**
 * Очередь живых карт (ADR-0074): карта создаётся только в видимой плитке и
 * только если свободен слот; остальные видимые ждут (заглушка), ушедшие с
 * экрана освобождают слот. Первыми получают слоты те, что раньше появились на
 * экране; «Показать карту» ставит плитку вперёд очереди.
 */
export class MapSlots {
  private readonly visible = new Map<string, number>()
  private live = new Set<string>()
  private counter = 0
  private paused = false
  private readonly listeners = new Set<() => void>()

  constructor(private readonly limit: number = LIVE_MAPS) {}

  /** Плитка появилась на экране или ушла с него. */
  show(id: string, visible: boolean): void {
    if (visible && !this.visible.has(id)) this.visible.set(id, ++this.counter)
    if (!visible) this.visible.delete(id)
    this.assign()
  }

  /** Вперёд очереди: вытесняет карту, дольше всех занимающую слот. */
  promote(id: string): void {
    if (!this.visible.has(id)) return
    this.visible.set(id, -++this.counter)
    this.assign()
  }

  /** Экран скрыт (дашборд под TV-режимом): живых карт нет. */
  setPaused(paused: boolean): void {
    this.paused = paused
    this.assign()
  }

  isLive(id: string): boolean {
    return this.live.has(id)
  }

  isVisible(id: string): boolean {
    return this.visible.has(id)
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Слоты — первым по очереди видимым; подписчики сверяют свои снимки сами. */
  private assign(): void {
    this.live = this.paused
      ? new Set<string>()
      : new Set(
          [...this.visible]
            .sort((a, b) => a[1] - b[1])
            .slice(0, this.limit)
            .map(([id]) => id),
        )
    for (const listener of this.listeners) listener()
  }
}

/** Карты вне дашборда и тетради без своей очереди делят общую. */
const shared = new MapSlots()
const MapSlotsContext = createContext<MapSlots | null>(null)

export function MapSlotsProvider({
  limit = LIVE_MAPS,
  paused = false,
  children,
}: {
  limit?: number
  paused?: boolean
  children: ReactNode
}) {
  const [slots] = useState(() => new MapSlots(limit))
  useEffect(() => slots.setPaused(paused), [slots, paused])
  return <MapSlotsContext.Provider value={slots}>{children}</MapSlotsContext.Provider>
}

/**
 * Слот живой карты для элемента плитки: `live` — можно создавать карту,
 * `visible` — плитка на экране, `promote` — показать карту вне очереди.
 */
export function useMapSlot(element: Element | null): {
  live: boolean
  visible: boolean
  promote: () => void
} {
  const slots = useContext(MapSlotsContext) ?? shared
  const id = useId()
  useEffect(() => {
    if (!element) return
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1]
        if (entry) slots.show(id, entry.isIntersecting)
      },
      { rootMargin: '120px' },
    )
    observer.observe(element)
    return () => {
      observer.disconnect()
      slots.show(id, false)
    }
  }, [element, slots, id])
  const live = useSyncExternalStore(slots.subscribe, () => slots.isLive(id))
  const visible = useSyncExternalStore(slots.subscribe, () => slots.isVisible(id))
  return { live, visible, promote: () => slots.promote(id) }
}
