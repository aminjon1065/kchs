import { type Level, levelFromValue, levelValue, maxLevel } from '@kchs/contracts'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { grantAccess, readPrincipalsFor, revokeAccess } from '~/kernel/access/acl-service.js'
import { loadObject } from '~/kernel/access/authorize.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import type { Ctx } from '~/shared/context.js'
import type { Executor } from '~/shared/db/client.js'
import { aclEntries, documentParticipants, documents } from '~/shared/db/schema/index.js'

/**
 * Роль участника документа. Карточка даёт автора, ответственного, подписанта и
 * контролёра; вторая волна — участников маршрута (`route`), исполнителей
 * резолюций (`resolution`) и список ознакомления (`acknowledgment`).
 */
export type ParticipantRole =
  | 'author'
  | 'responsible'
  | 'signer'
  | 'controller'
  | 'route'
  | 'resolution'
  | 'acknowledgment'

export interface ParticipantEntry {
  userId: string
  role: ParticipantRole
  level: Level
}

/** Уровни участников карточки: обсуждают документ, но не правят регистрационные данные. */
export const CARD_LEVELS: Record<'author' | 'responsible' | 'signer' | 'controller', Level> = {
  author: 'edit',
  responsible: 'comment',
  signer: 'comment',
  controller: 'comment',
}

/** Метка записей ACL, выданных участием: только их снимает смена участников. */
const NOTE_PREFIX = 'participant:'

/**
 * Участники документа — производные права из отношений (03-access-model.md §5,
 * ADR-0080). Права выдаются тихими записями ACL ядра, как у поручений
 * (ADR-0060): документ одинаково видят `authorize`, списки, поиск, комнаты
 * realtime и системный датасет. Источник (`card`, `route:<экземпляр>`,
 * `resolution:<id>`) заменяет только свои строки; у пользователя остаётся
 * максимальный уровень по всем источникам. Запись ACL, выданная вручную
 * («Поделиться»), участием не снимается.
 */
export const DocumentParticipants = {
  async sync(
    tx: Executor,
    ctx: Ctx,
    documentId: string,
    source: string,
    entries: ParticipantEntry[],
  ): Promise<{ added: string[]; removed: string[] }> {
    const object = await loadObject(documentId, tx)
    if (!object) return { added: [], removed: [] }

    const unique = new Map<string, ParticipantEntry>()
    for (const entry of entries) unique.set(`${entry.userId}:${entry.role}`, entry)

    const before = await tx
      .select({ userId: documentParticipants.userId })
      .from(documentParticipants)
      .where(
        and(
          eq(documentParticipants.documentId, documentId),
          eq(documentParticipants.source, source),
        ),
      )
    await tx
      .delete(documentParticipants)
      .where(
        and(
          eq(documentParticipants.documentId, documentId),
          eq(documentParticipants.source, source),
        ),
      )
    if (unique.size > 0) {
      await tx.insert(documentParticipants).values(
        [...unique.values()].map((entry) => ({
          documentId,
          userId: entry.userId,
          role: entry.role,
          source,
          level: levelValue(entry.level),
        })),
      )
    }

    // Итоговый уровень пользователя — максимум по всем источникам участия
    const rows = await tx
      .select({
        userId: documentParticipants.userId,
        role: documentParticipants.role,
        level: documentParticipants.level,
      })
      .from(documentParticipants)
      .where(eq(documentParticipants.documentId, documentId))
    const wanted = new Map<string, { level: Level; roles: Set<string> }>()
    for (const row of rows) {
      if (row.userId === object.ownerId) continue
      const current = wanted.get(row.userId) ?? { level: 'none' as Level, roles: new Set() }
      current.level = maxLevel(current.level, levelFromValue(row.level))
      current.roles.add(row.role)
      wanted.set(row.userId, current)
    }

    const existing = await tx
      .select({
        principalId: aclEntries.principalId,
        level: aclEntries.level,
        note: aclEntries.note,
      })
      .from(aclEntries)
      .where(and(eq(aclEntries.objectId, documentId), eq(aclEntries.principalType, 'user')))
    const acl = new Map(existing.map((row) => [row.principalId, row]))

    const grants = [...wanted.entries()].flatMap(([userId, value]) => {
      const entry = acl.get(userId)
      const managed = entry?.note?.startsWith(NOTE_PREFIX) ?? false
      const note = `${NOTE_PREFIX}${[...value.roles].sort().join(',')}`
      // Ручная запись не ниже нужного уровня — не трогаем
      if (entry && !managed && entry.level >= levelValue(value.level)) return []
      if (entry && managed && entry.level === levelValue(value.level) && entry.note === note) {
        return []
      }
      return [{ principal: { type: 'user' as const, id: userId }, level: value.level, note }]
    })
    if (grants.length > 0) await grantAccess(tx, ctx, documentId, grants, { quiet: true })

    const removed = existing
      .filter(
        (row) =>
          row.note?.startsWith(NOTE_PREFIX) &&
          !wanted.has(row.principalId) &&
          row.principalId !== object.ownerId,
      )
      .map((row) => row.principalId)
    for (const userId of removed) {
      await revokeAccess(tx, ctx, documentId, { type: 'user', id: userId })
    }

    const had = new Set(before.map((row) => row.userId))
    const now = new Set([...unique.values()].map((entry) => entry.userId))
    const added = [...now].filter((id) => !had.has(id))
    const dropped = [...had].filter((id) => !now.has(id))
    if (added.length > 0 || dropped.length > 0) {
      await publishEvent(tx, ctx, {
        type: 'document.participants_changed',
        object: {
          id: documentId,
          type: 'document',
          spaceId: object.spaceId,
          title: object.title,
        },
        payload: { source, added, removed: dropped },
      })
    }
    if (grants.length > 0 || removed.length > 0) await refreshViewers(tx, documentId)
    return { added, removed: dropped }
  },

  async list(
    executor: Executor,
    documentId: string,
  ): Promise<Array<{ userId: string; role: string; source: string; level: Level }>> {
    const rows = await executor
      .select()
      .from(documentParticipants)
      .where(eq(documentParticipants.documentId, documentId))
    return rows.map((row) => ({
      userId: row.userId,
      role: row.role,
      source: row.source,
      level: levelFromValue(row.level),
    }))
  },

  /** Документы, где пользователь — участник с одной из ролей (для «Мои»). */
  async documentsOf(
    executor: Executor,
    userId: string,
    roles: ParticipantRole[],
  ): Promise<string[]> {
    if (roles.length === 0) return []
    const rows = await executor
      .select({ documentId: documentParticipants.documentId })
      .from(documentParticipants)
      .where(
        and(eq(documentParticipants.userId, userId), inArray(documentParticipants.role, roles)),
      )
    return [...new Set(rows.map((row) => row.documentId))]
  },
}

/**
 * Кто видит документ — принципалы из прав ядра (как фильтр поиска): столбец
 * `viewers` системного датасета «Документы» пересчитывается при каждом
 * изменении доступа, как у задач (ADR-0060).
 */
export async function refreshViewers(executor: Executor, documentId: string): Promise<void> {
  const principals = await readPrincipalsFor(documentId, executor)
  await executor.update(documents).set({ viewers: principals }).where(eq(documents.id, documentId))
}

/** Пересчёт `viewers` пачками — после смены прав журнала для всех его документов. */
export async function refreshJournalViewers(
  executor: Executor,
  journalId: string,
  batch = 200,
): Promise<number> {
  let total = 0
  let cursor = '00000000-0000-0000-0000-000000000000'
  for (;;) {
    const rows = await executor
      .select({ id: documents.id })
      .from(documents)
      .where(and(eq(documents.journalId, journalId), sql`${documents.id} > ${cursor}`))
      .orderBy(documents.id)
      .limit(batch)
    if (rows.length === 0) return total
    for (const row of rows) await refreshViewers(executor, row.id)
    total += rows.length
    cursor = rows[rows.length - 1]?.id ?? cursor
  }
}
