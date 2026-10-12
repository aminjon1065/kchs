import { z } from 'zod'
import { BigIntString, Timestamp, Uuid } from '../common/primitives.js'

/**
 * События: Модуль «Предупреждения» (CAP 1.2, ADR-0202). Домен `warning` целиком
 * принадлежит этому файлу (ADR-0189); общий каталог собирается в `catalog.ts`.
 */
const MsgType = z.enum(['Alert', 'Update', 'Cancel'])

export const WARNINGS_EVENTS = {
  'warning.created': z.object({
    msgType: MsgType,
    /** Прежнее предупреждение — у уточнения и отмены. */
    references: Uuid.nullable().default(null),
  }),
  'warning.updated': z.object({ changed: z.array(z.string()).default([]) }),
  /** Отправлено на решение уполномоченного лица: маршрут выпуска запущен. */
  'warning.submitted': z.object({ processId: Uuid }),
  /** Маршрут кончился без решения о выпуске: снова черновик. */
  'warning.returned': z.object({ outcome: z.string() }),
  /**
   * Опубликовано: CAP открыт снаружи. Вебхуки сайта и партнёров подписываются на
   * это событие; журнал решений дежурного ставит время доведения у сообщения-источника.
   */
  'warning.published': z.object({
    identifier: z.string(),
    msgType: MsgType,
    capStatus: z.enum(['Actual', 'Exercise', 'Test']),
    sent: Timestamp,
    references: Uuid.nullable().default(null),
    referencesIdentifier: z.string().nullable().default(null),
    event: z.string(),
    headline: z.string(),
    urgency: z.string(),
    severity: z.string(),
    certainty: z.string(),
    effective: Timestamp.nullable().default(null),
    expires: Timestamp.nullable().default(null),
    areas: z.array(z.string()).default([]),
    /** Адрес CAP снаружи. */
    capUrl: z.string(),
    sourceDatasetId: Uuid.nullable().default(null),
    sourceRowId: BigIntString.nullable().default(null),
  }),
  /** Прежнее предупреждение уточнено или отменено опубликованным новым. */
  'warning.superseded': z.object({
    by: Uuid,
    status: z.enum(['updated', 'cancelled']),
  }),
} as const satisfies Record<string, z.ZodType>
