import { z } from 'zod'
import { FilterNode } from '../common/filter.js'
import { ClassificationMethod } from './layer-style.js'

/**
 * Статистика поля слоя для классов и диапазонов стиля (07-gis-engine.md §4,
 * ADR-0075): агрегаты по всем строкам слоя с политиками смотрящего через
 * компилятор запросов, границы классов — по методу градуированного стиля.
 */

const FieldKey = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z_][a-z0-9_]*$/, 'ключ поля: snake_case')

export const LayerStatsInput = z.object({
  /** Числовое поле датасета слоя. */
  field: FieldKey,
  /** Нормализация: значение делится на это поле (площадь, население); ноль — пусто. */
  normalizeBy: FieldKey.nullable().default(null),
  /** Метод классификации; без него — только диапазон (размер, вес тепловой карты). */
  method: ClassificationMethod.exclude(['manual']).nullable().default(null),
  classes: z.number().int().min(3).max(9).default(5),
  /**
   * Фильтр слоя рабочей копии стиля (предпросмотр редактора); не задан —
   * фильтр сохранённого стиля, null — без фильтра.
   */
  filter: FilterNode.nullable().optional(),
})
export type LayerStatsInput = z.infer<typeof LayerStatsInput>

export const LayerStats = z.object({
  field: z.string(),
  normalizeBy: z.string().nullable(),
  /** Строк слоя, видимых смотрящему (с фильтром слоя). */
  count: z.number().int().nonnegative(),
  /** Строк без значения (при нормализации — и с нулевым делителем). */
  nulls: z.number().int().nonnegative(),
  min: z.number().nullable(),
  max: z.number().nullable(),
  mean: z.number().nullable(),
  /** Стандартное отклонение (генеральное). */
  stddev: z.number().nullable(),
  /** Края классов `[min, b1…b(k−1), max]` — как `classify` в `@kchs/map-style`; null — без метода. */
  breaks: z.array(z.number()).nullable(),
  method: ClassificationMethod.nullable(),
  classes: z.number().int().nullable(),
  /**
   * Квантили и естественные границы крупного слоя считаются по случайной
   * выборке строк: её размер; null — по всем строкам.
   */
  sample: z.number().int().nullable(),
})
export type LayerStats = z.infer<typeof LayerStats>
