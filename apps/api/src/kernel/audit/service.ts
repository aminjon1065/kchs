import type { AuditEntry } from '@kchs/contracts'
import { and, desc, eq, gte, lte, type SQL, sql } from 'drizzle-orm'
import type { Ctx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import { auditLog } from '~/shared/db/schema/index.js'
import { logger } from '~/shared/logger/index.js'

export type AuditSeverity = 'info' | 'notice' | 'warning' | 'critical'

export interface AuditInput {
  action: string
  objectId?: string | null
  objectType?: string | null
  details?: Record<string, unknown>
  severity?: AuditSeverity
  actorId?: string | null
  onBehalfOf?: string | null
  ip?: string | null
  userAgent?: string | null
}

/**
 * Неизменяемый журнал безопасности (17-security.md §6).
 * Пишется в той же транзакции, когда важна атомарность, иначе — отдельно.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function audit(ctx: Ctx, input: AuditInput, tx?: Executor): Promise<void> {
  const executor = tx ?? db()
  const isUser = ctx.kind === 'user'
  const rawActor = input.actorId ?? (isUser ? ctx.userId : ctx.initiatorId)
  // Гость по ссылке не является пользователем: `link:<id>` уходит в детали
  const isUuid = typeof rawActor === 'string' && UUID_RE.test(rawActor)
  try {
    await executor.insert(auditLog).values({
      actorId: isUuid ? rawActor : null,
      onBehalfOf: input.onBehalfOf ?? (isUser ? ctx.onBehalfOf : null),
      action: input.action,
      objectId: input.objectId ?? null,
      objectType: input.objectType ?? null,
      ip: input.ip ?? (isUser ? ctx.ip : null),
      userAgent: input.userAgent ?? (isUser ? ctx.userAgent : null),
      details: {
        ...(input.details ?? {}),
        ...(rawActor && !isUuid ? { actorRef: rawActor } : {}),
      },
      severity: input.severity ?? 'info',
    })
  } catch (error) {
    // Журнал аудита не должен ронять пользовательскую операцию,
    // но потеря записи — инцидент: логируем на уровне error.
    logger().error({ err: error, action: input.action }, 'не удалось записать аудит')
  }
}

export interface AuditQuery {
  actorId?: string
  action?: string
  objectId?: string
  from?: string
  to?: string
  severity?: AuditSeverity
  limit?: number
  cursor?: string
}

function auditConditions(query: AuditQuery): SQL[] {
  const conditions: SQL[] = []
  if (query.actorId) conditions.push(eq(auditLog.actorId, query.actorId))
  if (query.action) {
    const escaped = query.action.replace(/[\\%_]/g, (ch) => `\\${ch}`)
    conditions.push(sql`${auditLog.action} like ${`${escaped}%`}`)
  }
  if (query.objectId) conditions.push(eq(auditLog.objectId, query.objectId))
  if (query.severity) conditions.push(eq(auditLog.severity, query.severity))
  if (query.from) conditions.push(gte(auditLog.occurredAt, query.from))
  if (query.to) conditions.push(lte(auditLog.occurredAt, query.to))
  return conditions
}

/**
 * Выгрузка журнала пачками по ключу (без OFFSET): экспорт в CSV для проверок
 * и SIEM (P0-E15 S02). Не больше `max` записей.
 */
export async function* auditBatches(
  query: AuditQuery,
  batchSize = 1000,
  max = 100_000,
): AsyncGenerator<(typeof auditLog.$inferSelect)[]> {
  let cursor: number | null = null
  let sent = 0
  while (sent < max) {
    const conditions = auditConditions(query)
    if (cursor !== null) conditions.push(sql`${auditLog.id} < ${cursor}`)
    const rows = await db()
      .select()
      .from(auditLog)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(auditLog.id))
      .limit(Math.min(batchSize, max - sent))
    if (rows.length === 0) return
    yield rows
    sent += rows.length
    cursor = rows[rows.length - 1]?.id ?? null
    if (rows.length < batchSize) return
  }
}

export async function queryAudit(
  query: AuditQuery,
): Promise<{ items: AuditEntry[]; nextCursor: string | null }> {
  const limit = Math.min(query.limit ?? 50, 200)
  const conditions = auditConditions(query)
  if (query.cursor) conditions.push(sql`${auditLog.id} < ${Number(query.cursor)}`)

  const rows = await db()
    .select()
    .from(auditLog)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(auditLog.occurredAt), desc(auditLog.id))
    .limit(limit + 1)

  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows

  return {
    items: page.map((row) => ({
      id: String(row.id),
      occurredAt: row.occurredAt,
      actorId: row.actorId,
      onBehalfOf: row.onBehalfOf,
      action: row.action,
      objectId: row.objectId,
      objectType: row.objectType,
      ip: row.ip,
      userAgent: row.userAgent,
      details: row.details,
      severity: row.severity as AuditSeverity,
    })),
    nextCursor: hasMore ? String(page[page.length - 1]?.id) : null,
  }
}

/** Действия, обязательные к аудиту (17-security.md §6). */
export const AUDIT_ACTIONS = {
  login: 'user.login',
  loginFailed: 'user.login_failed',
  logout: 'user.logout',
  passwordChanged: 'user.password_changed',
  passwordResetByAdmin: 'user.password_reset_by_admin',
  mfaEnabled: 'user.mfa_enabled',
  mfaDisabled: 'user.mfa_disabled',
  sessionRevoked: 'session.revoked',
  aclChanged: 'acl.changed',
  roleAssigned: 'role.assigned',
  orgChanged: 'org.changed',
  userCreated: 'user.created',
  userBlocked: 'user.blocked',
  delegationStarted: 'delegation.started',
  delegationEnded: 'delegation.ended',
  fileDownloaded: 'file.downloaded',
  fileExported: 'data.exported',
  shareLinkCreated: 'share_link.created',
  shareLinkOpened: 'share_link.opened',
  confidentialAccess: 'document.confidential_access',
  adminMode: 'admin.mode_entered',
  settingsChanged: 'settings.changed',
  objectPurged: 'object.purged',
  auditExported: 'audit.exported',
  securityPolicyChanged: 'security.policy_changed',
  usersImported: 'users.imported',
  usersImportCredentialsDownloaded: 'users.import_credentials_downloaded',
  announcementPublished: 'announcement.published',
  announcementWithdrawn: 'announcement.withdrawn',
  businessCalendarChanged: 'business_calendar.changed',
  spaceAdminAssigned: 'space.admin_assigned',
} as const
