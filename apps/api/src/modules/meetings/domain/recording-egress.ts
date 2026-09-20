import {
  EgressClient,
  EncodedFileOutput,
  EncodedFileType,
  S3Upload,
  type WebhookEvent,
  WebhookReceiver,
} from 'livekit-server-sdk'
import { buckets } from '~/kernel/storage/s3.js'
import { config } from '~/shared/config/index.js'
import { errors } from '~/shared/errors.js'
import { logger } from '~/shared/logger/index.js'
import { requireMedia } from './livekit.js'

/**
 * Запись комнаты через LiveKit Egress (11-communications-meetings.md §3,
 * ADR-0092). api только просит начать и остановить: медиапоток идёт мимо него,
 * а готовый файл Egress кладёт прямо в объектное хранилище под ключ, который
 * api выдал заранее. О готовности медиасервер сообщает вебхуком — его подпись
 * проверяется тем же ключом установки, что и токены комнат.
 */

/** Итог запуска записи: идентификатор задания медиасервера. */
export interface StartedEgress {
  egressId: string
}

function egressClient(): EgressClient {
  const media = requireMedia()
  return new EgressClient(media.httpUrl, media.apiKey, media.apiSecret)
}

/**
 * Адрес хранилища для медиасервера. В контейнерах он совпадает с адресом api
 * (`http://minio:9000`), а при разработке на хосте api ходит в `localhost`,
 * куда контейнер Egress не достучится, — тогда адрес задаётся отдельно.
 */
function storageEndpoint(): string {
  const env = config()
  return env.S3_EGRESS_ENDPOINT?.trim() || env.S3_ENDPOINT
}

function fileOutput(storageKey: string): EncodedFileOutput {
  const env = config()
  return new EncodedFileOutput({
    fileType: EncodedFileType.MP4,
    filepath: storageKey,
    // Манифест рядом с записью не нужен: сведения о ней ведёт реестр
    disableManifest: true,
    output: {
      case: 's3',
      value: new S3Upload({
        accessKey: env.S3_ACCESS_KEY,
        secret: env.S3_SECRET_KEY,
        region: env.S3_REGION,
        endpoint: storageEndpoint(),
        bucket: buckets.files(),
        forcePathStyle: env.S3_FORCE_PATH_STYLE,
      }),
    },
  })
}

/** Начать запись комнаты одной дорожкой (сетка говорящих, mp4). */
export async function startRoomRecording(
  roomName: string,
  storageKey: string,
): Promise<StartedEgress> {
  const info = await egressClient().startRoomCompositeEgress(roomName, fileOutput(storageKey), {
    layout: 'grid',
  })
  return { egressId: info.egressId }
}

/**
 * Остановить запись. Медиасервер докладывает файл вебхуком, поэтому ошибка
 * «такого задания нет» (запись уже закончилась сама) не считается сбоем.
 */
export async function stopRoomRecording(egressId: string): Promise<void> {
  try {
    await egressClient().stopEgress(egressId)
  } catch (error) {
    logger().child({ module: 'meetings' }).warn({ err: error, egressId }, 'запись не остановлена')
  }
}

/** Проверка подписи вебхука медиасервера: тело читается как есть, без разбора. */
export async function verifyWebhook(
  body: string,
  authHeader: string | undefined,
): Promise<WebhookEvent> {
  const media = requireMedia()
  if (!authHeader) throw errors.unauthorized('Вебхук медиасервера без подписи')
  try {
    return await new WebhookReceiver(media.apiKey, media.apiSecret).receive(body, authHeader)
  } catch (error) {
    logger().child({ module: 'meetings' }).warn({ err: error }, 'подпись вебхука не подошла')
    throw errors.unauthorized('Подпись вебхука медиасервера недействительна')
  }
}

/** Файл записи из события `egress_ended`: ключ, размер и длительность. */
export interface EgressFileResult {
  storageKey: string | null
  sizeBytes: number | null
  durationSeconds: number | null
}

export function fileResultOf(event: WebhookEvent): EgressFileResult {
  const file = event.egressInfo?.fileResults?.[0]
  if (!file) return { storageKey: null, sizeBytes: null, durationSeconds: null }
  const duration = Number(file.duration ?? 0n)
  return {
    // Egress отдаёт путь в бакете — тот же, что api выдал при старте
    storageKey: file.filename || null,
    sizeBytes: file.size ? Number(file.size) : null,
    // Длительность приходит в наносекундах
    durationSeconds: duration > 0 ? Math.round(duration / 1_000_000_000) : null,
  }
}
