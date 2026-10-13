import type { MeResponse } from '@kchs/contracts'
import { CACHE_STORE, readOne, remove, write } from './store.js'

/**
 * Профиль вошедшего на устройстве (ADR-0207): приложение, открытое без сети, знает,
 * чья это очередь сводок и чьи справочники показывать. Запоминается ответ `/me` без
 * токена CSRF; стирается при выходе и когда сервер сказал, что сессии больше нет
 * (401), — и не живёт дольше недели без связи. Чужого профиля на общем устройстве не
 * откроется: остаётся только тот, кто не вышел.
 */
const KEY = 'profile:last'
const MAX_AGE_MS = 7 * 86_400_000

interface SavedProfile {
  key: string
  me: MeResponse
  at: number
}

export async function rememberProfile(me: MeResponse): Promise<void> {
  const value: SavedProfile = {
    key: KEY,
    me: { ...me, session: { ...me.session, csrfToken: '' } },
    at: Date.now(),
  }
  await write(CACHE_STORE, value).catch(() => undefined)
}

export async function savedProfile(now = Date.now()): Promise<MeResponse | null> {
  const saved = await readOne<SavedProfile>(CACHE_STORE, KEY).catch(() => undefined)
  if (!saved || now - saved.at > MAX_AGE_MS) return null
  return saved.me
}

export async function forgetProfile(): Promise<void> {
  await remove(CACHE_STORE, KEY).catch(() => undefined)
}
