import type {
  FieldFormat,
  FieldOption,
  FieldType,
  LangText,
  LayerGeometryType,
  Locale,
} from '@kchs/contracts'
import type { LayerSpecification } from '@maplibre/maplibre-gl-style-spec'

/** Семантические цвета дизайн-системы, доступные стилю слоя по имени. */
export const MAP_COLOR_TOKENS = [
  'accent',
  'success',
  'warning',
  'danger',
  'info',
  'neutral',
  'purple',
] as const
export type MapColorToken = (typeof MAP_COLOR_TOKENS)[number]

export const SEQUENTIAL_RAMPS = ['blue', 'teal', 'orange', 'viridis'] as const
export type SequentialRamp = (typeof SEQUENTIAL_RAMPS)[number]
export const DIVERGING_RAMPS = ['red-blue', 'brown-teal'] as const
export type DivergingRamp = (typeof DIVERGING_RAMPS)[number]

/**
 * Тема карты — конкретные цвета для компилятора. Стиль слоя хранит только имена
 * палитр и токенов; значения приходят снаружи: в браузере — из CSS-переменных
 * дизайн-системы (`readMapTheme` в `@kchs/ui`), в тестах — из tokens.json.
 * Пакет не зависит от `@kchs/ui` (ADR-0065).
 */
export interface MapTheme {
  mode: 'light' | 'dark'
  /** Категориальная палитра графиков (ADR-0049), 8 оттенков: `categorical.1…8`. */
  categorical: readonly string[]
  /** «Прочее»: значения вне категорий и правил, объекты без данных. */
  other: string
  /** Последовательные шкалы, 7 шагов от малого значения к большому (`--seq-*`). */
  sequential: Readonly<Record<SequentialRamp, readonly string[]>>
  /** Расходящиеся шкалы, 7 шагов: полюс → нейтраль → полюс (`--div-*`). */
  diverging: Readonly<Record<DivergingRamp, readonly string[]>>
  tokens: Readonly<Record<MapColorToken, string>>
  /** Текст подписей. */
  text: string
  /** Поверхность: гало подписей и кольцо кластеров. */
  surface: string
}

/** Поле датасета для стиля: подписи, форматы, варианты. FieldDef подходит как есть. */
export interface StyleField {
  key: string
  type: FieldType
  label?: LangText | null
  format?: FieldFormat | null
  options?: readonly FieldOption[] | null
}

/** Диапазон числового поля в данных слоя (статистика сервера или выборки). */
export interface FieldDomain {
  min: number
  max: number
  /** Сколько строк без значения: в легенде градуированного стиля — «Нет данных». */
  nulls?: number
}

export interface MapStyleContext {
  /** Идентификатор слоя: префикс id слоёв MapLibre (`<id>:fill`, `<id>:label`…). */
  id: string
  /** Источник MapLibre, из которого рисует слой. */
  source: string
  /**
   * Слой векторного источника: тайлы сервера — `layer` (ST_AsMVT), по умолчанию.
   * null — GeoJSON-источник без слоёв.
   */
  sourceLayer?: string | null
  /** Геометрия данных слоя; `mixed` и отсутствие — геометрия из стиля. */
  geometry?: LayerGeometryType | null
  /** Поля датасета: подписи легенды, форматы, варианты выбора, типы для условий. */
  fields: readonly StyleField[]
  theme: MapTheme
  locale?: Locale
  /** Название слоя — подпись легенды простого стиля. */
  name?: string | null
  /** Границы классов градуированного стиля от `classify` (кроме ручного метода). */
  breaks?: readonly number[] | null
  /** Диапазоны полей: размер по значению, вес тепловой карты, число точек кластера. */
  domains?: Readonly<Record<string, FieldDomain>>
  /** Кадр времени (мс эпохи) для слоя со временем; без него время фильтрует сервер (`t`). */
  time?: { from: number; to: number } | null
  /**
   * Применить фильтр слоя на клиенте: GeoJSON со всеми полями (предпросмотр
   * редактора). По умолчанию фильтр слоя применяет сервер в тайлах и объектах.
   */
  clientFilter?: boolean
  /** Дочерние территории — для условия `within` с `includeChildren`. */
  territoryDescendants?: (id: string) => readonly string[]
  /** «Сейчас», мс эпохи: относительные периоды и макросы `@today`, `@now`. */
  now?: number
  /** Часовой пояс дат в условиях («весь день»); по умолчанию UTC. */
  timezone?: string
  /** Стеки шрифтов подписей — из glyphs базовой карты. */
  fonts?: { regular: readonly string[]; bold: readonly string[] }
}

/** Изображение, которое MapView регистрирует как SDF до добавления слоёв. */
export interface MapImageRequest {
  /** `kchs-shape-<форма>` или `kchs-icon-<имя>`. */
  id: string
  kind: 'shape' | 'icon'
  name: string
  sdf: true
}

export type StyleWarningCode =
  | 'geometry-mismatch'
  | 'field-missing'
  | 'breaks-missing'
  | 'domain-missing'
  | 'renderer-geometry'
  | 'filter-unsupported'
  | 'color-unknown'
  | 'category-duplicate'
  | 'label-placement'
  | 'label-format'

/** Замечание компилятора: стиль нарисован, но не так, как описан (для редактора стиля). */
export interface StyleWarning {
  code: StyleWarningCode
  /** Путь в LayerStyle: `renderer.field`, `renderer.rules.2.filter`… */
  path: string
  detail?: string
}

export type PointShape = 'circle' | 'square' | 'triangle' | 'icon'

export type LegendSwatch =
  | { kind: 'fill'; color: string; opacity: number; outline: string | null; outlineWidth: number }
  | {
      kind: 'line'
      color: string
      width: number
      dash: readonly number[] | null
      opacity: number
    }
  | {
      kind: 'point'
      shape: PointShape
      color: string
      outline: string
      /** Диаметр, px. */
      size: number
      opacity: number
      icon: string | null
    }
  | {
      kind: 'heatmap-gradient'
      stops: ReadonlyArray<{ offset: number; color: string }>
      low: string
      high: string
    }
  | {
      kind: 'proportional-circle'
      color: string
      outline: string
      /** Диаметр, px; `maxSize` — самый крупный в группе, для выравнивания. */
      size: number
      maxSize: number
      opacity: number
    }
  | { kind: 'cluster'; color: string; outline: string; text: string; size: number; count: string }

export interface LegendItem {
  id: string
  label: string
  swatch: LegendSwatch
}

export interface LegendSection {
  id: string
  /** Заголовок части легенды (размер по полю, кластеры); у основной — null. */
  title: string | null
  items: LegendItem[]
}

/** Легенда слоя: из тех же классов и категорий, что и слои MapLibre. */
export interface LegendModel {
  show: boolean
  title: string | null
  sections: LegendSection[]
  /** Пояснение для пользователя: например, классы ещё не рассчитаны. */
  note: string | null
}

export interface CompiledLayerStyle {
  /** Слои MapLibre снизу вверх: заливка, обводка, линии, тепловая, точки, кластеры, подписи. */
  layers: LayerSpecification[]
  legend: LegendModel
  images: MapImageRequest[]
  warnings: StyleWarning[]
}
