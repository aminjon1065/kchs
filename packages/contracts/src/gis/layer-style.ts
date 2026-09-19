import { z } from 'zod'
import { FilterNode } from '../common/filter.js'
import { LangText } from '../common/primitives.js'
import { FieldFormat } from '../fields/field-def.js'

/**
 * Стиль слоя (контракт `docs/contracts/layer-style.md`): декларативное описание,
 * не зависящее от MapLibre. Компилятор `packages/map-style` строит из него слои
 * MapLibre и легенду; печать и плитки используют ту же спецификацию.
 */

export const LAYER_GEOMETRIES = ['point', 'line', 'polygon'] as const
export const LayerGeometry = z.enum(LAYER_GEOMETRIES)
export type LayerGeometry = z.infer<typeof LayerGeometry>

/** Палитры дизайн-системы; для тёмной темы — автоматические варианты. */
export const STYLE_PALETTES = [
  'categorical',
  'blue',
  'teal',
  'orange',
  'viridis',
  'red-blue',
  'brown-teal',
  'status',
] as const
export const StylePaletteName = z.enum(STYLE_PALETTES)
export type StylePaletteName = z.infer<typeof StylePaletteName>

export const CLASSIFICATION_METHODS = [
  'equal',
  'quantile',
  'jenks',
  'manual',
  'log',
  'stddev',
] as const
export const ClassificationMethod = z.enum(CLASSIFICATION_METHODS)
export type ClassificationMethod = z.infer<typeof ClassificationMethod>

/** Ключ поля датасета (как в FieldDef) или служебное поле тайла (`point_count`). */
const FieldKey = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z_][a-z0-9_]*$/, 'ключ поля: snake_case')

/**
 * Цвет: токен палитры (`categorical.1`), семантический токен (`danger`, `accent`),
 * `auto` (производный от основного цвета) или пользовательский `#rrggbb`.
 */
export const StyleColor = z
  .string()
  .min(1)
  .max(40)
  .regex(/^(#[0-9a-fA-F]{6}|auto|[a-z][a-z-]*(\.\d{1,2})?)$/, 'токен палитры или #rrggbb')
export type StyleColor = z.infer<typeof StyleColor>

export const StylePalette = z.object({
  name: StylePaletteName,
  reverse: z.boolean().default(false),
})
export type StylePalette = z.infer<typeof StylePalette>

const Scale = z.enum(['linear', 'sqrt', 'log'])
const Icon = z.string().min(1).max(64)
const CategoryValue = z.union([z.string().max(500), z.number(), z.boolean(), z.null()])

const SimpleRenderer = z.object({
  kind: z.literal('simple'),
  color: StyleColor.default('categorical.1'),
  icon: Icon.nullable().default(null),
})

const CategorizedRenderer = z.object({
  kind: z.literal('categorized'),
  field: FieldKey,
  categories: z
    .array(
      z.object({
        value: CategoryValue,
        label: LangText.optional(),
        color: StyleColor,
        icon: Icon.nullable().optional(),
        size: z.number().min(1).max(64).optional(),
      }),
    )
    .max(100),
  /** Значения вне списка; null — такие объекты не рисуются. */
  other: z.object({ color: StyleColor, label: LangText.optional() }).nullable().default(null),
})

const GraduatedRenderer = z.object({
  kind: z.literal('graduated'),
  field: FieldKey,
  method: ClassificationMethod.default('quantile'),
  classes: z.number().int().min(3).max(9).default(5),
  /** Границы классов: для `manual` — обязательны, для остальных — вычисленные (кэш). */
  breaks: z.array(z.number()).max(10).nullable().default(null),
  palette: StylePalette.default({ name: 'blue', reverse: false }),
  /** Нормализация: значение делится на поле (площадь, население). */
  normalizeBy: FieldKey.nullable().default(null),
  visual: z.object({ target: z.enum(['fill', 'size', 'both']).default('fill') }).default({
    target: 'fill',
  }),
})

const HeatmapRenderer = z.object({
  kind: z.literal('heatmap'),
  weightField: FieldKey.nullable().default(null),
  radius: z.number().min(1).max(100).default(20),
  intensity: z.number().min(0.1).max(5).default(1),
  palette: StylePalette.default({ name: 'orange', reverse: false }),
})

const ProportionalRenderer = z.object({
  kind: z.literal('proportional'),
  field: FieldKey,
  min: z.number().min(1).max(64).default(4),
  max: z.number().min(2).max(96).default(24),
  scale: Scale.default('sqrt'),
  color: StyleColor.default('categorical.1'),
})

const RuleRenderer = z.object({
  kind: z.literal('rule'),
  rules: z
    .array(
      z.object({
        filter: FilterNode,
        label: LangText.optional(),
        color: StyleColor,
        icon: Icon.nullable().optional(),
        size: z.number().min(1).max(64).optional(),
      }),
    )
    .min(1)
    .max(50),
  other: z.object({ color: StyleColor, label: LangText.optional() }).nullable().default(null),
})

export const StyleRenderer = z.discriminatedUnion('kind', [
  SimpleRenderer,
  CategorizedRenderer,
  GraduatedRenderer,
  HeatmapRenderer,
  ProportionalRenderer,
  RuleRenderer,
])
export type StyleRenderer = z.infer<typeof StyleRenderer>
export const STYLE_RENDERERS = [
  'simple',
  'categorized',
  'graduated',
  'heatmap',
  'proportional',
  'rule',
] as const

export const LayerStyle = z.object({
  version: z.literal(1),
  geometry: LayerGeometry,
  renderer: StyleRenderer,
  point: z
    .object({
      shape: z.enum(['circle', 'square', 'triangle', 'icon']).default('circle'),
      size: z.number().min(1).max(64).default(8),
      icon: Icon.nullable().default(null),
      sizeBy: z
        .object({
          field: FieldKey,
          min: z.number().min(1).max(64).default(4),
          max: z.number().min(2).max(96).default(24),
          scale: Scale.default('sqrt'),
        })
        .nullable()
        .default(null),
    })
    .default({ shape: 'circle', size: 8, icon: null, sizeBy: null }),
  line: z
    .object({
      width: z.number().min(0.5).max(20).default(2),
      dash: z.array(z.number().min(0).max(20)).max(8).nullable().default(null),
      cap: z.enum(['butt', 'round', 'square']).default('round'),
    })
    .default({ width: 2, dash: null, cap: 'round' }),
  polygon: z
    .object({
      fillOpacity: z.number().min(0).max(1).default(0.6),
      outline: z
        .object({
          width: z.number().min(0).max(10).default(1),
          color: StyleColor.default('auto'),
        })
        .default({ width: 1, color: 'auto' }),
    })
    .default({ fillOpacity: 0.6, outline: { width: 1, color: 'auto' } }),
  /** Параметры тепловой карты — в рендерере `heatmap`; ключ контракта оставлен пустым. */
  heatmap: z.null().default(null),
  /** Кластеры точек: на тайлах сервера — поле `point_count`. */
  cluster: z
    .object({
      enabled: z.boolean().default(true),
      radius: z.number().int().min(10).max(200).default(40),
      maxZoom: z.number().int().min(0).max(22).default(11),
      style: z
        .object({
          sizeBy: z.literal('point_count').default('point_count'),
          min: z.number().min(8).max(96).default(16),
          max: z.number().min(8).max(128).default(48),
        })
        .default({ sizeBy: 'point_count', min: 16, max: 48 }),
    })
    .nullable()
    .default(null),
  label: z
    .object({
      field: FieldKey.nullable().default(null),
      /** Шаблон с полями: `{{name}} ({{capacity}})`; поле или шаблон. */
      template: z.string().max(200).nullable().default(null),
      size: z.number().min(8).max(32).default(12),
      halo: z.boolean().default(true),
      minZoom: z.number().min(0).max(22).default(9),
      priority: z.enum(['size', 'field', 'none']).default('none'),
      placement: z.enum(['auto', 'point', 'line']).default('auto'),
    })
    .nullable()
    .default(null),
  /** Всплывающая карточка: заголовок-шаблон, 3–5 полей, кнопки действий. */
  popup: z
    .object({
      title: z.string().max(200),
      fields: z.array(FieldKey).max(20),
      actions: z.array(z.enum(['open', 'documents', 'instruction'])).max(3),
    })
    .nullable()
    .default(null),
  opacity: z.number().min(0).max(1).default(1),
  minZoom: z.number().min(0).max(24).default(0),
  maxZoom: z.number().min(0).max(24).default(22),
  /** Фильтр слоя поверх политик строк: какие строки датасета показывает слой. */
  filter: FilterNode.nullable().default(null),
  legend: z
    .object({
      title: LangText.nullable().default(null),
      format: FieldFormat.nullable().default(null),
      show: z.boolean().default(true),
    })
    .default({ title: null, format: null, show: true }),
  /** Время на карте: слайдер момента или диапазона по полю даты. */
  time: z
    .object({
      field: FieldKey,
      mode: z.enum(['instant', 'range', 'cumulative']).default('range'),
      step: z.enum(['hour', 'day', 'week', 'month', 'year']).default('day'),
    })
    .nullable()
    .default(null),
  /** 3D-экструзия и растры — фаза 3 (07-gis-engine.md §14). */
  extrusion: z.null().default(null),
  raster: z.null().default(null),
})
export type LayerStyle = z.infer<typeof LayerStyle>
export type LayerStyleInput = z.input<typeof LayerStyle>
