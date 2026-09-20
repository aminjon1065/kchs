import { z } from 'zod'
import { CronPattern, TimezoneName } from '../automation/rule.js'
import { Timestamp, Uuid } from '../common/primitives.js'
import { MetricPeriod } from '../data/metric.js'

/**
 * Алерты (06-analytics-engine.md §14, ADR-0104). Правило на показатель:
 * условие (порог, изменение в процентах, аномалия по z-score с учётом
 * сезонности), разрез, расписание проверки, каналы и период тишины.
 * Срабатывание — событие `alert.fired` в outbox.
 */

/** Ключ поля-разреза показателя. */
const FieldKey = z.string().min(1).max(160)

export const ALERT_CONDITION_KINDS = ['threshold', 'change', 'anomaly'] as const
export const AlertConditionKind = z.enum(ALERT_CONDITION_KINDS)
export type AlertConditionKind = z.infer<typeof AlertConditionKind>

export const ALERT_COMPARE_OPS = ['gt', 'gte', 'lt', 'lte'] as const
export const AlertCompareOp = z.enum(ALERT_COMPARE_OPS)
export type AlertCompareOp = z.infer<typeof AlertCompareOp>

/** Порог: значение показателя сравнивается с числом. */
export const AlertThresholdCondition = z.object({
  kind: z.literal('threshold'),
  op: AlertCompareOp,
  value: z.number(),
})
export type AlertThresholdCondition = z.infer<typeof AlertThresholdCondition>

/** Изменение в процентах к базе сравнения показателя. */
export const AlertChangeCondition = z.object({
  kind: z.literal('change'),
  direction: z.enum(['up', 'down', 'any']).default('any'),
  percent: z.number().min(0).max(100_000),
  comparison: z.enum(['previous_period', 'previous_year']).default('previous_period'),
})
export type AlertChangeCondition = z.infer<typeof AlertChangeCondition>

/**
 * Аномалия: отклонение последнего значения истории от среднего в единицах
 * стандартного отклонения. Сезонность `weekly` сравнивает точку с теми же
 * днями недели, `monthly` — с теми же днями месяца.
 */
export const AlertAnomalyCondition = z.object({
  kind: z.literal('anomaly'),
  z: z.number().min(1).max(10).default(3),
  /** Сколько точек истории берётся для оценки. */
  points: z.number().int().min(4).max(400).default(30),
  seasonality: z.enum(['none', 'weekly', 'monthly']).default('none'),
})
export type AlertAnomalyCondition = z.infer<typeof AlertAnomalyCondition>

export const AlertCondition = z.discriminatedUnion('kind', [
  AlertThresholdCondition,
  AlertChangeCondition,
  AlertAnomalyCondition,
])
export type AlertCondition = z.infer<typeof AlertCondition>

export const AlertChannels = z.object({
  /** Уведомление платформы (категория `data`). */
  notify: z.boolean().default(true),
  /** Дело во Входящих: «Разобраться с алертом». */
  inbox: z.boolean().default(false),
  /** Письмо получателям. */
  email: z.boolean().default(false),
})
export type AlertChannels = z.infer<typeof AlertChannels>

export const AlertSchedule = z.object({ cron: CronPattern, timezone: TimezoneName })
export type AlertSchedule = z.infer<typeof AlertSchedule>

export const AlertDefinition = z.object({
  metricId: Uuid,
  description: z.string().trim().max(1000).nullable().default(null),
  condition: AlertCondition,
  /** Разрез: условие проверяется по каждому значению разреза отдельно. */
  dimensions: z.array(FieldKey).max(2).default([]),
  /** Период значения; не задан — период показателя, null — всё время. */
  period: MetricPeriod.nullish(),
  schedule: AlertSchedule,
  /** Получатели на языке назначений маршрутов (`user:`, `role:`, `unit_head(…)`). */
  recipients: z.array(z.string().trim().min(1).max(200)).max(50).default([]),
  channels: AlertChannels.prefault({}),
  /** Период тишины после срабатывания, минуты. */
  cooldownMinutes: z.number().int().min(0).max(43_200).default(60),
})
export type AlertDefinition = z.infer<typeof AlertDefinition>

const Name = z.string().trim().min(1).max(200)

export const AlertRecord = z.object({
  id: Uuid,
  name: z.string(),
  spaceId: Uuid,
  parentId: Uuid.nullable(),
  metricId: Uuid,
  metricName: z.string().nullable(),
  definition: AlertDefinition,
  enabled: z.boolean(),
  lastCheckedAt: Timestamp.nullable(),
  lastFiredAt: Timestamp.nullable(),
  nextRunAt: Timestamp.nullable(),
  canManage: z.boolean(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
})
export type AlertRecord = z.infer<typeof AlertRecord>

export const AlertListItem = z.object({
  id: Uuid,
  name: z.string(),
  spaceId: Uuid,
  metricId: Uuid,
  metricName: z.string().nullable(),
  conditionKind: AlertConditionKind,
  enabled: z.boolean(),
  lastFiredAt: Timestamp.nullable(),
  nextRunAt: Timestamp.nullable(),
  /** Срабатываний за последние сутки. */
  firedToday: z.number().int().nonnegative(),
  updatedAt: Timestamp,
})
export type AlertListItem = z.infer<typeof AlertListItem>

export const AlertList = z.object({ items: z.array(AlertListItem) })
export type AlertList = z.infer<typeof AlertList>

export const AlertListQuery = z.object({
  spaceId: Uuid.optional(),
  metricId: Uuid.optional(),
  enabled: z.stringbool().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})
export type AlertListQuery = z.infer<typeof AlertListQuery>

export const AlertCreateInput = z.object({
  name: Name,
  spaceId: Uuid,
  parentId: Uuid.nullable().optional(),
  definition: AlertDefinition,
  enabled: z.boolean().default(false),
})
export type AlertCreateInput = z.infer<typeof AlertCreateInput>

export const AlertUpdateInput = z.object({
  name: Name.optional(),
  definition: AlertDefinition,
})
export type AlertUpdateInput = z.infer<typeof AlertUpdateInput>

export const AlertEnabledInput = z.object({ enabled: z.boolean() })
export type AlertEnabledInput = z.infer<typeof AlertEnabledInput>

/** Одно значение разреза: ключ группы и её подпись. */
export const AlertGroup = z.object({
  key: z.string(),
  label: z.string(),
  values: z.record(z.string(), z.unknown()),
})
export type AlertGroup = z.infer<typeof AlertGroup>

/** Итог проверки одной группы: сработало ли и почему. */
export const AlertCheckOutcome = z.object({
  group: AlertGroup,
  fired: z.boolean(),
  value: z.number().nullable(),
  base: z.number().nullable(),
  /** Отклонение в процентах (условие `change`) или z-score (условие `anomaly`). */
  score: z.number().nullable(),
  /** Почему не сработало или не проверялось. */
  reason: z.string().nullable(),
  /** Срабатывание подавлено периодом тишины. */
  suppressed: z.boolean(),
})
export type AlertCheckOutcome = z.infer<typeof AlertCheckOutcome>

export const AlertCheckResult = z.object({
  alertId: Uuid,
  checkedAt: Timestamp,
  /** Тестовый прогон: рассылки и запись в историю не было. */
  dryRun: z.boolean(),
  outcomes: z.array(AlertCheckOutcome),
  fired: z.number().int().nonnegative(),
})
export type AlertCheckResult = z.infer<typeof AlertCheckResult>

export const AlertEvent = z.object({
  id: Uuid,
  alertId: Uuid,
  alertName: z.string(),
  metricId: Uuid,
  firedAt: Timestamp,
  group: AlertGroup,
  value: z.number().nullable(),
  base: z.number().nullable(),
  score: z.number().nullable(),
  message: z.string(),
  /** Кому ушло: каналы доставки. */
  channels: z.array(z.string()),
})
export type AlertEvent = z.infer<typeof AlertEvent>

export const AlertEventList = z.object({ items: z.array(AlertEvent) })
export type AlertEventList = z.infer<typeof AlertEventList>

export const AlertEventsQuery = z.object({
  /** История по показателю — отметки на графике карточки. */
  metricId: Uuid.optional(),
  alertId: Uuid.optional(),
  from: Timestamp.optional(),
  to: Timestamp.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})
export type AlertEventsQuery = z.infer<typeof AlertEventsQuery>

export const AlertCheckInput = z.object({
  /** Тестовый прогон: посчитать и показать, но ничего не рассылать. */
  dryRun: z.boolean().default(false),
})
export type AlertCheckInput = z.infer<typeof AlertCheckInput>
