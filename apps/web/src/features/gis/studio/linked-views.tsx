import type { FilterNode } from '@kchs/contracts'
import { IconButton } from '@kchs/ui'
import { Link2, X } from 'lucide-react'
import { useEffect, useMemo, useRef } from 'react'
import { useT } from '~/app/i18n.js'
import {
  LINKED_SELECTION_LIMIT,
  type LinkedSelection,
  linkKey,
  useLinkSource,
  usePaneLinkGroup,
  useViewContext,
} from '~/app/workspace/view-context.js'
import { type FeatureRef, useStudio } from './context.js'

/** Задержка публикации охвата после движения карты, мс. */
const EXTENT_DELAY = 250

interface MapDataset {
  layerIds: string[]
  /** Поле геометрии, которое рисует первый слой датасета. */
  field: string
}

const sameIds = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((id, index) => id === b[index])

/** Строки датасета в выделении студии — без повторов (у датасета может быть два слоя). */
export function datasetRowIds(
  selection: readonly FeatureRef[],
  layerIds: readonly string[],
): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const ref of selection) {
    if (!layerIds.includes(ref.layerId) || seen.has(ref.rowId)) continue
    seen.add(ref.rowId)
    out.push(ref.rowId)
  }
  return out
}

/** Выделение студии с чужим выделением датасета: строки — на всех его слоях. */
export function withDatasetSelection(
  selection: readonly FeatureRef[],
  layerIds: readonly string[],
  ids: readonly string[],
): FeatureRef[] {
  const others = selection.filter((ref) => !layerIds.includes(ref.layerId))
  const linked = layerIds.flatMap((layerId) => ids.map((rowId) => ({ layerId, rowId })))
  return [...others, ...linked].slice(0, LINKED_SELECTION_LIMIT)
}

/**
 * Связь карты-студии с соседними панелями (ViewContext, ADR-0073): выделение
 * объектов ↔ выделенные строки датасета, фильтр связанной панели (кисть
 * графика) → условие тайлов слоёв датасета (`setLayerFilter`), охват карты →
 * «в охвате карты» у таблицы датасета. Без группы связи — ничего.
 */
export function StudioLinks() {
  const t = useT()
  const studio = useStudio()
  const group = usePaneLinkGroup()
  const source = useLinkSource(group)
  const links = useViewContext((s) => s.links)
  const latest = useRef(studio)
  latest.current = studio

  const datasetsKey = studio.layers
    .map((item) =>
      item.layer?.dataAccess
        ? `${item.layer.id}:${item.layer.datasetId}:${item.layer.geometryField}`
        : '',
    )
    .join('|')
  // biome-ignore lint/correctness/useExhaustiveDependencies: состав слоёв — по ключу
  const datasets = useMemo(() => {
    const out = new Map<string, MapDataset>()
    for (const item of studio.layers) {
      const layer = item.layer
      if (!layer?.dataAccess) continue
      const entry = out.get(layer.datasetId) ?? { layerIds: [], field: layer.geometryField }
      entry.layerIds.push(layer.id)
      out.set(layer.datasetId, entry)
    }
    return out
  }, [datasetsKey])

  // ─── Выделение из соседней панели → объекты на карте ─────────────────────
  const inbound = useRef(new Map<string, LinkedSelection>())
  useEffect(() => {
    if (!group) return
    const current = latest.current
    let next: FeatureRef[] | null = null
    for (const [datasetId, info] of datasets) {
      const selection = links[linkKey(group, datasetId)]?.selection
      if (!selection || selection.source === source) continue
      // Та же публикация уже применена: выделение на карте с тех пор могло смениться
      if (inbound.current.get(datasetId) === selection) continue
      inbound.current.set(datasetId, selection)
      const base = next ?? [...current.selection]
      if (sameIds(datasetRowIds(base, info.layerIds), selection.ids)) continue
      next = withDatasetSelection(base, info.layerIds, selection.ids)
    }
    if (next) current.setSelection(next)
  }, [group, links, datasets, source])

  // ─── Выделение на карте → строки датасета для соседних панелей ───────────
  useEffect(() => {
    if (!group) return
    const store = useViewContext.getState()
    for (const [datasetId, info] of datasets) {
      const ids = datasetRowIds(studio.selection, info.layerIds)
      const published = store.links[linkKey(group, datasetId)]?.selection
      // Чужое выделение, только что применённое к карте, обратно не публикуется
      if (published && published.source !== source && sameIds(published.ids, ids)) continue
      if (ids.length === 0 && published?.source !== source) continue
      store.select(group, datasetId, ids, source)
    }
  }, [group, studio.selection, datasets, source])

  // ─── Фильтр соседней панели → условие тайлов слоёв датасета ──────────────
  const applied = useRef(new Map<string, FilterNode>())
  useEffect(() => {
    const { setLayerFilter } = latest.current
    const wanted = new Map<string, FilterNode>()
    if (group) {
      for (const [datasetId, info] of datasets) {
        const filter = links[linkKey(group, datasetId)]?.filter
        if (!filter || filter.source === source) continue
        for (const layerId of info.layerIds) wanted.set(layerId, filter.where)
      }
    }
    for (const [layerId, where] of wanted) {
      if (applied.current.get(layerId) === where) continue
      applied.current.set(layerId, where)
      setLayerFilter(layerId, where)
    }
    for (const layerId of [...applied.current.keys()]) {
      if (wanted.has(layerId)) continue
      applied.current.delete(layerId)
      setLayerFilter(layerId, null)
    }
  }, [group, links, datasets, source])

  // ─── Охват карты → «в охвате карты» у таблицы датасета ───────────────────
  const map = studio.map
  const camera = studio.camera
  const published = useRef(new Set<string>())
  // biome-ignore lint/correctness/useExhaustiveDependencies: camera — сигнал, что карта остановилась в новом виде
  useEffect(() => {
    if (!group || !map) return
    const timer = setTimeout(() => {
      const store = useViewContext.getState()
      let bounds: ReturnType<typeof map.getBounds>
      try {
        bounds = map.getBounds()
      } catch {
        return
      }
      const bbox = [
        Math.max(-180, bounds.getWest()),
        Math.max(-90, bounds.getSouth()),
        Math.min(180, bounds.getEast()),
        Math.min(90, bounds.getNorth()),
      ] as [number, number, number, number]
      for (const [datasetId, info] of datasets) {
        store.extent(group, datasetId, { bbox, field: info.field }, source)
      }
      // Датасет убран с карты — его охват и выделение больше не публикуются
      for (const datasetId of published.current) {
        if (datasets.has(datasetId)) continue
        store.extent(group, datasetId, null, source)
        store.select(group, datasetId, [], source)
      }
      published.current = new Set(datasets.keys())
    }, EXTENT_DELAY)
    return () => clearTimeout(timer)
  }, [group, map, camera, datasets, source])

  if (!group) return null
  const filters = [...datasets.keys()].flatMap((datasetId) => {
    const filter = links[linkKey(group, datasetId)]?.filter
    return filter && filter.source !== source ? [{ datasetId, label: filter.label }] : []
  })
  if (filters.length === 0) return null
  return (
    // Под поиском, слева: справа — кнопки масштаба карты
    <div className="pointer-events-none absolute left-2 right-12 top-12 z-10 flex flex-col items-start gap-1">
      {filters.map((filter) => (
        <div
          key={filter.datasetId}
          className="pointer-events-auto flex max-w-[min(32rem,100%)] items-center gap-1.5 rounded-md border border-line bg-surface py-0.5 pl-2 pr-0.5 text-xs text-fg-secondary shadow-sm"
        >
          <Link2 className="size-3.5 shrink-0 text-accent" aria-hidden />
          <span className="truncate">{t('gis.links.filter', { label: filter.label })}</span>
          <IconButton
            label={t('gis.links.clearFilter')}
            size="sm"
            onClick={() =>
              useViewContext.getState().filter(group, filter.datasetId, null, source, true)
            }
          >
            <X className="size-3.5" aria-hidden />
          </IconButton>
        </div>
      ))}
    </div>
  )
}
