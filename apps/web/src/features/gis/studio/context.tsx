import type { Bbox, FilterNode, LayerRecord, LayerStyle, MapCamera, MapSpec } from '@kchs/contracts'
import type { LegendModel, StyleWarning } from '@kchs/map-style'
import type { MapInstance } from '@kchs/ui'
import { createContext, useContext } from 'react'
import type { PanelLayer } from '../layer-panel.js'

/** Объект слоя на карте: слой и строка его датасета (`_id`). */
export interface FeatureRef {
  layerId: string
  rowId: string
}

/**
 * Правая панель студии. Новая панель — ключ здесь и ветка в `StudioSidePanel`
 * (side-panel.tsx), компонент — в своём файле `studio/*`.
 */
export type StudioPanelKind = 'style' | 'edit'

export interface StudioContextValue {
  mapId: string
  spaceId: string
  /** Экземпляр MapLibre — для инструментов поверх карты; null, пока карта не создана. */
  map: MapInstance | null
  /** Рабочая спецификация карты (с несохранённой правкой). */
  spec: MapSpec
  editSpec: (change: (spec: MapSpec) => MapSpec) => void
  canEdit: boolean
  layers: readonly PanelLayer[]
  layerById: ReadonlyMap<string, LayerRecord>
  camera: MapCamera
  setCamera: (camera: MapCamera) => void
  fitBounds: (bbox: Bbox) => void
  /** Выделенные объекты: подсвечены на карте, отмечены в атрибутивной таблице. */
  selection: readonly FeatureRef[]
  setSelection: (refs: FeatureRef[]) => void
  /** Слой, с которым работают таблица, стиль и правка. */
  activeLayerId: string | null
  setActiveLayerId: (layerId: string | null) => void
  panel: { kind: StudioPanelKind; layerId: string | null } | null
  openPanel: (kind: StudioPanelKind, layerId?: string | null) => void
  closePanel: () => void
  attributesOpen: boolean
  setAttributesOpen: (open: boolean) => void
  /**
   * Дополнительные условия тайлов по слоям (связанные представления, фильтры
   * дашборда) — FilterNode по полям датасета слоя, передаётся тайлам как `f`.
   */
  layerFilters: Readonly<Record<string, FilterNode>>
  setLayerFilter: (layerId: string, filter: FilterNode | null) => void
  /** Легенды и замечания компилятора стилей по слоям — как нарисовано сейчас. */
  legends: ReadonlyMap<string, LegendModel>
  warnings: ReadonlyMap<string, readonly StyleWarning[]>
  /**
   * Рабочие копии стилей из редактора стиля (ADR-0075): рисуются вместо
   * сохранённых, в карту не сохраняются; стиль сохраняет слой.
   */
  styleDrafts: Readonly<Record<string, LayerStyle>>
  setStyleDraft: (layerId: string, style: LayerStyle | null) => void
  /**
   * Инструмент, которому принадлежат щелчки по карте (правка объектов,
   * измерение…): пока он задан, щелчок не открывает карточку объекта.
   */
  mapTool: string | null
  setMapTool: (tool: string | null) => void
}

const StudioContext = createContext<StudioContextValue | null>(null)

export const StudioProvider = StudioContext.Provider

/** Состояние карты-студии для инструментов и панелей (ADR-0072). */
export function useStudio(): StudioContextValue {
  const value = useContext(StudioContext)
  if (!value) throw new Error('useStudio outside MapStudio')
  return value
}
