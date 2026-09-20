import { AccessToken, RoomServiceClient } from 'livekit-server-sdk'
import { config } from '~/shared/config/index.js'
import { errors } from '~/shared/errors.js'
import { logger } from '~/shared/logger/index.js'

/**
 * Медиасервер LiveKit (11-communications-meetings.md §3, ADR-0089): токены
 * комнаты выпускает api по правам участника, сам медиапоток идёт мимо него.
 * Без `LIVEKIT_URL`, `LIVEKIT_API_KEY` и `LIVEKIT_API_SECRET` встречи
 * выключены — интерфейс не показывает кнопок звонка.
 */
export interface MediaConfig {
  /** Адрес для клиента: `ws://` или `wss://`. */
  url: string
  /** Тот же адрес по HTTP — для серверного API комнат. */
  httpUrl: string
  apiKey: string
  apiSecret: string
}

/** Токен комнаты живёт час: клиент переподключается с новым по запросу. */
export const TOKEN_TTL_SECONDS = 3600
/** Гостю по ссылке — короче: доступ только на время встречи. */
export const GUEST_TOKEN_TTL_SECONDS = 900

export function mediaConfig(): MediaConfig | null {
  const env = config()
  const url = env.LIVEKIT_URL?.trim()
  const apiKey = env.LIVEKIT_API_KEY?.trim()
  const apiSecret = env.LIVEKIT_API_SECRET?.trim()
  if (!url || !apiKey || !apiSecret) return null
  return { url, httpUrl: url.replace(/^ws/, 'http'), apiKey, apiSecret }
}

export function requireMedia(): MediaConfig {
  const media = mediaConfig()
  if (!media) throw errors.unavailable('Медиасервер не настроен')
  return media
}

/** Комната встречи: имя стабильно и не раскрывает ничего, кроме идентификатора. */
export function roomNameFor(meetingId: string): string {
  return `meeting-${meetingId}`
}

export interface TokenInput {
  roomName: string
  /** Кем участник виден в комнате: идентификатор пользователя или `guest:<id>`. */
  identity: string
  displayName: string
  canPublish: boolean
  /** Право записи — способность `meetings.record` (ADR-0089). */
  canRecord: boolean
  ttlSeconds?: number
  metadata?: Record<string, unknown>
}

export interface IssuedToken {
  token: string
  expiresAt: string
}

/** Токен входа в комнату с правами участника. */
export async function roomToken(input: TokenInput): Promise<IssuedToken> {
  const media = requireMedia()
  const ttl = input.ttlSeconds ?? TOKEN_TTL_SECONDS
  const token = new AccessToken(media.apiKey, media.apiSecret, {
    identity: input.identity,
    name: input.displayName,
    ttl,
    ...(input.metadata ? { metadata: JSON.stringify(input.metadata) } : {}),
  })
  token.addGrant({
    room: input.roomName,
    roomJoin: true,
    canPublish: input.canPublish,
    canSubscribe: true,
    canPublishData: true,
    // Запись включает и выключает тот, кому это разрешено правами встречи
    roomRecord: input.canRecord,
  })
  return {
    token: await token.toJwt(),
    expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
  }
}

function client(): RoomServiceClient {
  const media = requireMedia()
  return new RoomServiceClient(media.httpUrl, media.apiKey, media.apiSecret)
}

/**
 * Закрыть комнату: медиасервер отключает всех. Встреча завершается в базе в
 * любом случае — недоступный медиасервер не должен оставить её «идущей».
 */
export async function closeRoom(roomName: string): Promise<void> {
  if (!mediaConfig()) return
  try {
    await client().deleteRoom(roomName)
  } catch (error) {
    logger().child({ module: 'meetings' }).warn({ err: error, roomName }, 'комната не закрыта')
  }
}
