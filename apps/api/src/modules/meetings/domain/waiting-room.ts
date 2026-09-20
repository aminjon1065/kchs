import type { MeetingKnock } from '@kchs/contracts'
import { newId } from '~/shared/ids.js'
import { redis } from '~/shared/redis/index.js'

/**
 * Комната ожидания (ADR-0091): гость по ссылке ждёт, пока его впустит тот, кто
 * ведёт встречу. Заявка живёт в Redis — она эфемерна, как присутствие, и
 * исчезает вместе со встречей; в базе и реестре её место не нужно.
 */
const KNOCK_TTL_SECONDS = 3600

const knocksKey = (meetingId: string) => `kchs:meeting:knocks:${meetingId}`

export type KnockState = 'waiting' | 'admitted' | 'denied'

interface KnockRow {
  name: string
  requestedAt: string
  state: KnockState
}

async function rows(meetingId: string): Promise<Map<string, KnockRow>> {
  const raw = await redis().hgetall(knocksKey(meetingId))
  const result = new Map<string, KnockRow>()
  for (const [id, value] of Object.entries(raw)) {
    try {
      result.set(id, JSON.parse(value) as KnockRow)
    } catch {
      // повреждённую запись просто пропускаем
    }
  }
  return result
}

async function put(meetingId: string, id: string, row: KnockRow): Promise<void> {
  const key = knocksKey(meetingId)
  await redis().hset(key, id, JSON.stringify(row))
  await redis().expire(key, KNOCK_TTL_SECONDS)
}

/** Гость постучался: заявка ждёт решения. */
export async function knock(meetingId: string, name: string): Promise<string> {
  const id = newId()
  await put(meetingId, id, { name, requestedAt: new Date().toISOString(), state: 'waiting' })
  return id
}

export async function knockState(
  meetingId: string,
  id: string,
): Promise<{ state: KnockState; name: string } | null> {
  const row = (await rows(meetingId)).get(id)
  return row ? { state: row.state, name: row.name } : null
}

/** Ожидающие — тому, кто ведёт встречу. */
export async function pendingKnocks(meetingId: string): Promise<MeetingKnock[]> {
  return [...(await rows(meetingId))]
    .filter(([, row]) => row.state === 'waiting')
    .map(([id, row]) => ({ id, name: row.name, requestedAt: row.requestedAt }))
    .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt))
}

/** Решение организатора: впустить или отказать. */
export async function decideKnock(
  meetingId: string,
  id: string,
  admit: boolean,
): Promise<{ name: string } | null> {
  const row = (await rows(meetingId)).get(id)
  if (!row) return null
  await put(meetingId, id, { ...row, state: admit ? 'admitted' : 'denied' })
  return { name: row.name }
}

/** Встреча завершена — ожидающим больше нечего ждать. */
export async function clearKnocks(meetingId: string): Promise<void> {
  await redis().del(knocksKey(meetingId))
}
