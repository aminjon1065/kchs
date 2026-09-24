import { and, eq, inArray } from 'drizzle-orm'
import { db, type Executor } from '~/shared/db/client.js'
import { users } from '~/shared/db/schema/index.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Служебные учётные записи из списка (ADR-0130). От их имени работают правила и
 * интеграции; уведомлений и дел им не положено — фильтр стоит в ядре уведомлений
 * и Входящих, а не в каждом модуле-подписчике.
 */
export async function serviceAccountIds(
  userIds: readonly string[],
  database: Executor = db(),
): Promise<Set<string>> {
  const ids = [...new Set(userIds)].filter((id) => UUID.test(id))
  if (ids.length === 0) return new Set()
  const rows = await database
    .select({ id: users.id })
    .from(users)
    .where(and(inArray(users.id, ids), eq(users.kind, 'service')))
  return new Set(rows.map((row) => row.id))
}

export async function isServiceAccount(
  userId: string,
  database: Executor = db(),
): Promise<boolean> {
  return (await serviceAccountIds([userId], database)).has(userId)
}
