import { z } from 'zod'
import { Timestamp, Uuid } from '../common/primitives.js'

/**
 * Качество данных (06-analytics-engine.md §15, ADR-0101): правила проверяются
 * при новой версии датасета, результат виден в карточке и бейджем в каталоге.
 * Правила описывают ожидания от данных, а не права — доступ к датасету обычный.
 */

export const QUALITY_KINDS = [
  'not_null',
  'unique',
  'range',
  'regex',
  'in_set',
  'referential',
  'geometry_valid',
  'freshness',
  'row_count_delta',
] as const
export const QualityKind = z.enum(QUALITY_KINDS)
export type QualityKind = z.infer<typeof QualityKind>

/** `error` — данные считаются негодными, `warning` — повод посмотреть. */
export const QualitySeverity = z.enum(['error', 'warning'])
export type QualitySeverity = z.infer<typeof QualitySeverity>

/** Параметры правила: у каждого вида свои, лишние игнорируются. */
export const QualityParams = z.object({
  /** `range`: границы включительно. */
  min: z.number().optional(),
  max: z.number().optional(),
  /** `regex`: выражение Postgres (`~`). */
  pattern: z.string().max(300).optional(),
  /** `in_set`: допустимые значения. */
  values: z.array(z.string().max(200)).max(200).optional(),
  /** `referential`: где искать значение. */
  datasetId: Uuid.optional(),
  datasetField: z.string().max(64).optional(),
  /** `freshness`: данные не старше N часов. */
  maxAgeHours: z
    .number()
    .int()
    .min(1)
    .max(24 * 365)
    .optional(),
  /** `row_count_delta`: падение числа строк к прошлой версии, % */
  maxDropPercent: z.number().min(0).max(100).optional(),
})
export type QualityParams = z.infer<typeof QualityParams>

export const QualityRule = z.object({
  key: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9_-]+$/, 'Ключ правила — латиница, цифры, дефис и подчёркивание'),
  kind: QualityKind,
  /** Поле датасета; у `row_count_delta` поля нет. */
  field: z.string().max(64).nullable().default(null),
  params: QualityParams.default({}),
  severity: QualitySeverity.default('error'),
  enabled: z.boolean().default(true),
})
export type QualityRule = z.infer<typeof QualityRule>

export const QualityRulesInput = z.object({
  rules: z.array(QualityRule).max(50),
})
export type QualityRulesInput = z.infer<typeof QualityRulesInput>

/** `error` — правило не выполнилось само (например, поля больше нет). */
export const QualityRuleStatus = z.enum(['ok', 'failed', 'error'])
export type QualityRuleStatus = z.infer<typeof QualityRuleStatus>

export const QualityRuleResult = z.object({
  key: z.string(),
  kind: QualityKind,
  field: z.string().nullable(),
  severity: QualitySeverity,
  status: QualityRuleStatus,
  /** Сколько строк нарушили правило. */
  failed: z.number().int(),
  checked: z.number().int(),
  /** Первые нарушившие строки — открыть их в таблице. */
  sample: z.array(z.string()).max(10).default([]),
  message: z.string().nullable().default(null),
})
export type QualityRuleResult = z.infer<typeof QualityRuleResult>

/** Сводка: `unknown` — правил нет или проверка ещё не шла. */
export const QUALITY_STATUSES = ['unknown', 'ok', 'warning', 'failed'] as const
export const QualityStatus = z.enum(QUALITY_STATUSES)
export type QualityStatus = z.infer<typeof QualityStatus>

export const DatasetQuality = z.object({
  status: QualityStatus,
  /** Версия датасета, на которой считали. */
  version: z.number().int().nullable(),
  checkedAt: Timestamp.nullable(),
  rules: z.array(QualityRule),
  results: z.array(QualityRuleResult),
  /** Право менять правила (уровень `manage` на датасете). */
  canManage: z.boolean(),
})
export type DatasetQuality = z.infer<typeof DatasetQuality>
