import { z } from 'zod'
import { Uuid } from '../common/primitives.js'

/**
 * События: Ознакомления (08-documents.md §10, ADR-0084). Домены `acknowledgment` целиком
 * принадлежат этому файлу (ADR-0189); общий каталог собирается в `catalog.ts`.
 */
export const ACKNOWLEDGMENT_EVENTS = {
  // ── acknowledgments (08-documents.md §10, ADR-0084) ───────────────────────
  // Объект события — объект, с которым знакомят (документ, страница базы знаний)
  /** Запрос ознакомления: вручную, правилом типа при регистрации или шагом маршрута. */
  'acknowledgment.requested': z.object({
    requestId: Uuid,
    source: z.string(),
    userIds: z.array(Uuid),
    dueAt: z.string().nullable(),
  }),
  /** Сотрудник ознакомился; actor события — кто отметил (заместитель — от имени). */
  'acknowledgment.acknowledged': z.object({
    userId: Uuid,
    requestIds: z.array(Uuid),
    secondFactor: z.boolean(),
  }),
  /** Запрос снят (шаг маршрута отменён, сотрудник снят с шага). */
  'acknowledgment.cancelled': z.object({ requestId: Uuid, userIds: z.array(Uuid) }),
  /** Напоминание не ознакомившимся: вручную или в день срока. */
  'acknowledgment.reminded': z.object({ userIds: z.array(Uuid), auto: z.boolean() }),
} as const satisfies Record<string, z.ZodType>
