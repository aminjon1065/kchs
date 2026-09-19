import type { Bbox, FilterNode } from '@kchs/contracts'
import { createContext, useContext, useEffect, useId } from 'react'
import { create } from 'zustand'

/**
 * Связанные представления — ViewContext (06-analytics-engine.md §17, ADR-0073).
 *
 * Панели рабочего пространства с одной группой связи (`PaneState.linkGroup`,
 * цветная метка на панели) делят состояние по датасету: выделенные строки
 * (`_id`), фильтр (кисть графика) и охват карты. Представление публикует своё
 * от имени источника (`useLinkSource`) и читает чужое; закрытое представление
 * снимает свои публикации. Хранилище — только в памяти вкладки браузера.
 */

/** Группы связи — цвета меток, как у групп вкладок. */
export const LINK_GROUPS = ['blue', 'orange', 'green', 'red', 'purple'] as const
export type LinkGroup = (typeof LINK_GROUPS)[number]

/** Предел выделенных строк в связи — столько же объектов отдаёт слой GeoJSON. */
export const LINKED_SELECTION_LIMIT = 5000

export interface LinkedSelection {
  ids: readonly string[]
  source: string
}

export interface LinkedFilter {
  where: FilterNode
  /** Подпись условия для чипа потребителя: «Дата: 01.03.2026 – 31.05.2026». */
  label: string
  source: string
}

export interface LinkedExtent {
  bbox: Bbox
  /** Поле геометрии датасета, которое рисует карта. */
  field: string
  source: string
}

export interface LinkedDataset {
  selection: LinkedSelection | null
  filter: LinkedFilter | null
  extent: LinkedExtent | null
}

export const NO_LINKS: LinkedDataset = { selection: null, filter: null, extent: null }

export const linkKey = (group: string, datasetId: string) => `${group}|${datasetId}`

type Slot = keyof LinkedDataset

interface ViewContextStore {
  links: Readonly<Record<string, LinkedDataset>>
  /** Выделение строк источника; пустой список снимает выделение этого же источника. */
  select: (group: string, datasetId: string, ids: readonly string[], source: string) => void
  /**
   * Фильтр источника; null снимает фильтр этого источника, а с `force` — любой
   * (чип потребителя «×»).
   */
  filter: (
    group: string,
    datasetId: string,
    filter: { where: FilterNode; label: string } | null,
    source: string,
    force?: boolean,
  ) => void
  extent: (
    group: string,
    datasetId: string,
    extent: { bbox: Bbox; field: string } | null,
    source: string,
  ) => void
  /** Представление закрыто или ушло из группы: его публикации снимаются. */
  clearSource: (source: string) => void
}

function patch(
  links: Readonly<Record<string, LinkedDataset>>,
  key: string,
  slot: Slot,
  value: LinkedDataset[Slot],
): Record<string, LinkedDataset> {
  const current = links[key] ?? NO_LINKS
  const next = { ...current, [slot]: value }
  const out = { ...links }
  if (!next.selection && !next.filter && !next.extent) delete out[key]
  else out[key] = next
  return out
}

export const useViewContext = create<ViewContextStore>()((set, get) => ({
  links: {},

  select: (group, datasetId, ids, source) => {
    const key = linkKey(group, datasetId)
    const current = get().links[key]?.selection ?? null
    const limited = ids.slice(0, LINKED_SELECTION_LIMIT)
    // Пустое выделение снимает только своё: открытая таблица без выделения не
    // стирает выделение, пришедшее с карты
    if (limited.length === 0 && current?.source !== source) return
    if (
      current?.source === source &&
      current.ids.length === limited.length &&
      current.ids.every((id, index) => id === limited[index])
    ) {
      return
    }
    set({ links: patch(get().links, key, 'selection', { ids: limited, source }) })
  },

  filter: (group, datasetId, filter, source, force = false) => {
    const key = linkKey(group, datasetId)
    const current = get().links[key]?.filter ?? null
    if (!filter) {
      if (!current || (!force && current.source !== source)) return
      set({ links: patch(get().links, key, 'filter', null) })
      return
    }
    if (
      current?.source === source &&
      current.label === filter.label &&
      JSON.stringify(current.where) === JSON.stringify(filter.where)
    ) {
      return
    }
    set({ links: patch(get().links, key, 'filter', { ...filter, source }) })
  },

  extent: (group, datasetId, extent, source) => {
    const key = linkKey(group, datasetId)
    const current = get().links[key]?.extent ?? null
    if (!extent) {
      if (current?.source !== source) return
      set({ links: patch(get().links, key, 'extent', null) })
      return
    }
    if (
      current?.source === source &&
      current.field === extent.field &&
      current.bbox.every((value, index) => value === extent.bbox[index])
    ) {
      return
    }
    set({ links: patch(get().links, key, 'extent', { ...extent, source }) })
  },

  clearSource: (source) => {
    let links = get().links
    let changed = false
    for (const [key, entry] of Object.entries(links)) {
      for (const slot of ['selection', 'filter', 'extent'] as const) {
        if (entry[slot]?.source === source) {
          links = patch(links, key, slot, null)
          changed = true
        }
      }
    }
    if (changed) set({ links })
  },
}))

/** Группа связи панели, в которой отрисована вкладка; null — панель не связана. */
export const PaneLinkContext = createContext<string | null>(null)

export function usePaneLinkGroup(): string | null {
  return useContext(PaneLinkContext)
}

/**
 * Источник публикаций представления: его выделение, фильтр и охват снимаются,
 * когда представление закрыто или панель сменила группу.
 */
export function useLinkSource(group: string | null): string {
  const source = useId()
  const clearSource = useViewContext((s) => s.clearSource)
  // biome-ignore lint/correctness/useExhaustiveDependencies: смена группы — повод снять прежние публикации
  useEffect(() => () => clearSource(source), [source, clearSource, group])
  return source
}

/** Связанное состояние датасета в группе панели; без группы — пустое. */
export function useLinkedDataset(
  group: string | null,
  datasetId: string | null | undefined,
): LinkedDataset {
  return useViewContext((s) =>
    group && datasetId ? (s.links[linkKey(group, datasetId)] ?? NO_LINKS) : NO_LINKS,
  )
}

/** Строк грида, которые просматриваются в поиске загруженных: «выделить всё» на миллионах. */
const SCAN_LIMIT = 100_000

/** Строки `_id` выделенных отрезков грида — только загруженные, не больше предела. */
export function idsOfSpans(
  spans: ReadonlyArray<readonly [number, number]>,
  idAt: (index: number) => string | undefined,
  limit = LINKED_SELECTION_LIMIT,
): string[] {
  const out: string[] = []
  let scanned = 0
  for (const [start, end] of spans) {
    for (let index = start; index <= end; index++) {
      const id = idAt(index)
      if (id !== undefined) out.push(id)
      scanned += 1
      if (out.length >= limit || scanned >= SCAN_LIMIT) return out
    }
  }
  return out
}

/** Первая свободная группа связи — для новой пары панелей. */
export function freeLinkGroup(used: ReadonlyArray<string | null | undefined>): LinkGroup {
  return LINK_GROUPS.find((group) => !used.includes(group)) ?? LINK_GROUPS[0]
}
