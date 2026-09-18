import { cacheKeys, redis } from '~/shared/redis/index.js'

/**
 * Присутствие: кто сейчас смотрит объект (02-platform-kernel.md §Realtime,
 * 16-api-and-events.md §3). Клиент подтверждает просмотр видимой вкладки раз
 * в 30 с (`presence.view`) и прощается при уходе (`presence.leave`); отметка
 * без подтверждения дольше минуты считается ушедшей — вкладку могли закрыть
 * без прощания, а соединение — ещё не разорваться.
 */
export const PRESENCE_TTL_MS = 70_000

export interface Viewer {
  id: string
  displayName: string
  avatarUrl: string | null
}

interface Mark {
  displayName: string
  at: number
}

/** Кто смотрит сейчас; устаревшие отметки удаляются. */
export async function viewers(objectId: string, now = Date.now()): Promise<Viewer[]> {
  const key = cacheKeys.presence(objectId)
  const raw = await redis().hgetall(key)
  const fresh: Viewer[] = []
  const stale: string[] = []
  for (const [id, value] of Object.entries(raw)) {
    const mark = JSON.parse(value) as Mark
    if (now - mark.at > PRESENCE_TTL_MS) stale.push(id)
    else fresh.push({ id, displayName: mark.displayName, avatarUrl: null })
  }
  if (stale.length > 0) await redis().hdel(key, ...stale)
  return fresh
}

export async function markViewing(
  objectId: string,
  user: { id: string; displayName: string },
  now = Date.now(),
): Promise<Viewer[]> {
  const key = cacheKeys.presence(objectId)
  const mark: Mark = { displayName: user.displayName, at: now }
  await redis().hset(key, user.id, JSON.stringify(mark))
  // Ключ целиком исчезает, если объект никто не смотрит пару минут
  await redis().expire(key, 120)
  return viewers(objectId, now)
}

export async function markLeft(
  objectId: string,
  userId: string,
  now = Date.now(),
): Promise<Viewer[]> {
  await redis().hdel(cacheKeys.presence(objectId), userId)
  return viewers(objectId, now)
}
