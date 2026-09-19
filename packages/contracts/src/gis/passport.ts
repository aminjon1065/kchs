import { z } from 'zod'
import { DateOnly, LangText, Uuid } from '../common/primitives.js'
import { MetricValue } from '../data/metric.js'
import { FieldFormat } from '../fields/field-def.js'
import { TerritoryLevel } from './territory.js'

/**
 * Паспорт территории (07-gis-engine.md §11, 03-screens.md §11, P2-E04 S05,
 * ADR-0077): показатели по датасетам с полем территории, привязанные показатели,
 * поручения и дочерние единицы — всё с правами и политиками смотрящего.
 */

/**
 * Период показателей: последние 12 месяцев (сравнение — с 12 месяцами до них),
 * текущий год (с прошлым) или всё время (без сравнения).
 */
export const PASSPORT_PERIODS = ['12m', 'year', 'all'] as const
export const PassportPeriod = z.enum(PASSPORT_PERIODS)
export type PassportPeriod = z.infer<typeof PassportPeriod>

export const TerritoryPassportQuery = z.object({ period: PassportPeriod.default('12m') })
export type TerritoryPassportQuery = z.infer<typeof TerritoryPassportQuery>

/** Интервал дат включительно — в поясе пользователя. */
export const PassportWindow = z.object({ from: DateOnly, to: DateOnly })
export type PassportWindow = z.infer<typeof PassportWindow>

/** Сумма меры датасета по территории: за период и за предыдущий период. */
export const PassportMeasure = z.object({
  key: z.string(),
  label: LangText,
  format: FieldFormat.nullable(),
  value: z.number().nullable(),
  previous: z.number().nullable(),
})
export type PassportMeasure = z.infer<typeof PassportMeasure>

/** Датасет с полем территории: строки в территории (с вложенными) и суммы мер. */
export const PassportDataset = z.object({
  id: Uuid,
  name: z.string(),
  spaceId: Uuid,
  territoryField: z.string(),
  /** Поле времени датасета; без него период не действует — показатели за всё время. */
  timeField: z.string().nullable(),
  geometryField: z.string().nullable(),
  /** Строк за период; null — показатель не посчитан (`error`). */
  rows: z.number().int().nonnegative().nullable(),
  /** Строк за предыдущий период; null — сравнения нет. */
  previousRows: z.number().int().nonnegative().nullable(),
  measures: z.array(PassportMeasure),
  /** Строк по месяцам периода — искра показателя. */
  series: z.array(z.object({ period: DateOnly, rows: z.number().int().nonnegative() })),
  /** Строк за период по дочерним единицам: идентификатор → число. */
  children: z.record(z.string(), z.number().int().nonnegative()),
  /** Слои датасета, видимые смотрящему, — объекты на карте паспорта. */
  layers: z.array(z.object({ id: Uuid, name: z.string() })),
  error: z.string().nullable(),
})
export type PassportDataset = z.infer<typeof PassportDataset>

/** Показатель, привязанный к территории или её предку связью `about_territory`. */
export const PassportMetric = MetricValue.extend({
  /** Территория, к которой привязан показатель: эта или один из предков. */
  linkedTo: Uuid,
})
export type PassportMetric = z.infer<typeof PassportMetric>

/** Дочерняя единица: население и площадь — для таблицы и мини-хороплета. */
export const PassportChild = z.object({
  id: Uuid,
  code: z.string(),
  level: TerritoryLevel,
  name: LangText,
  population: z.number().nullable(),
  areaKm2: z.number().nullable(),
  hasGeometry: z.boolean(),
})
export type PassportChild = z.infer<typeof PassportChild>

/** Задачи и поручения с территорией (и вложенными), видимые смотрящему. */
export const PassportTasks = z.object({
  open: z.number().int().nonnegative(),
  overdue: z.number().int().nonnegative(),
  closed: z.number().int().nonnegative(),
})
export type PassportTasks = z.infer<typeof PassportTasks>

export const TerritoryPassport = z.object({
  territoryId: Uuid,
  period: PassportPeriod,
  /** Окно периода и предыдущее окно; у «всего времени» — null. */
  window: PassportWindow.nullable(),
  previousWindow: PassportWindow.nullable(),
  datasets: z.array(PassportDataset),
  metrics: z.array(PassportMetric),
  tasks: PassportTasks,
  /** Уровень дочерних единиц (у большинства); нет дочерних — null. */
  childLevel: TerritoryLevel.nullable(),
  children: z.array(PassportChild),
})
export type TerritoryPassport = z.infer<typeof TerritoryPassport>
