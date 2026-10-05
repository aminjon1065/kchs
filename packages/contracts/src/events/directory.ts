import { z } from 'zod'
import { Uuid } from '../common/primitives.js'
import { empty } from './shared.js'

/**
 * События: Справочник людей и оргструктуры, вход и сессии (ADR-0179). Домены `user`, `org`, `role`, `delegation`, `session`, `directory` целиком
 * принадлежат этому файлу (ADR-0189); общий каталог собирается в `catalog.ts`.
 */
export const DIRECTORY_EVENTS = {
  // ── identity ──────────────────────────────────────────────────────────────
  'user.created': z.object({
    login: z.string(),
    /** Служебная учётная запись (ADR-0130) создаётся тем же событием. */
    kind: z.enum(['person', 'service']).default('person'),
  }),
  'user.updated': empty,
  'user.blocked': z.object({ reason: z.string().nullable().default(null) }),
  'user.login': z.object({ ip: z.string().nullable(), userAgent: z.string().nullable() }),
  'user.login_failed': z.object({ login: z.string(), reason: z.string() }),
  'user.logout': empty,
  'user.password_changed': empty,
  'user.mfa_enabled': z.object({ kind: z.string() }),
  'user.mfa_disabled': z.object({ kind: z.string() }),
  'user.roles_changed': z.object({ userId: Uuid, roles: z.array(z.string()) }),
  /** Своя роль организации заведена, изменена или удалена (ADR-0165). */
  'role.created': z.object({ roleId: Uuid, key: z.string(), capabilities: z.array(z.string()) }),
  'role.updated': z.object({ roleId: Uuid, key: z.string(), capabilities: z.array(z.string()) }),
  'role.deleted': z.object({ roleId: Uuid, key: z.string() }),
  /** Допуск к грифам изменён администратором системы (ADR-0080). */
  'user.clearance_changed': z.object({ userId: Uuid, from: z.string(), to: z.string() }),
  /** Telegram привязан к пользователю (ADR-0061); chat_id в событие не попадает. */
  'user.telegram_linked': z.object({ userId: Uuid }),
  /** Привязка снята: самим пользователем или потому что бот заблокирован. */
  'user.telegram_unlinked': z.object({ userId: Uuid, reason: z.enum(['user', 'blocked']) }),
  /** Ключ входа (passkey) добавлен или отозван (ADR-0098); сам ключ в событие не попадает. */
  'user.passkey_added': z.object({ userId: Uuid, name: z.string() }),
  'user.passkey_removed': z.object({ userId: Uuid, name: z.string() }),
  /** Учётная запись связана с внешним поставщиком входа (OIDC или каталог). */
  'user.identity_linked': z.object({ userId: Uuid, provider: z.string() }),
  'org.unit_changed': z.object({ unitId: Uuid, change: z.string() }),
  'org.employment_changed': z.object({ userId: Uuid, unitId: Uuid.nullable() }),
  /**
   * Группа создана, изменена или сменила состав (ADR-0177): состав входит в
   * принципалы участников, поэтому кого добавили и убрали — в событии.
   */
  'org.group_changed': z.object({
    groupId: Uuid,
    change: z.enum(['created', 'updated', 'members']),
    added: z.array(Uuid).default([]),
    removed: z.array(Uuid).default([]),
  }),
  /** Должность создана, изменена или удалена (ADR-0177). */
  'org.position_changed': z.object({
    positionId: Uuid,
    change: z.enum(['created', 'updated', 'deleted']),
  }),
  'delegation.started': z.object({ fromUserId: Uuid, toUserId: Uuid, scope: z.string() }),
  'delegation.ended': z.object({ fromUserId: Uuid, toUserId: Uuid }),
  'session.revoked': z.object({ sessionIds: z.array(Uuid) }),
  'role.assigned': z.object({ userId: Uuid, roleKey: z.string() }),
  /** Прогон синхронизации каталога завершён. */
  'directory.synced': z.object({
    runId: Uuid,
    mode: z.string(),
    status: z.string(),
    created: z.number().int().nonnegative(),
    updated: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative(),
  }),
} as const satisfies Record<string, z.ZodType>
