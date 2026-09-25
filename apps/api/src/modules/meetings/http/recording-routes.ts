import {
  MeetingSettings,
  RecordingList,
  RecordingPinInput,
  RecordingRecord,
  TranscriptRecord,
  TranscriptResult,
} from '@kchs/contracts'
import { z } from 'zod'
import { db } from '~/shared/db/client.js'
import { errors } from '~/shared/errors.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { validServiceToken } from '~/shared/http/service-token.js'
import { verifyWebhook } from '../domain/recording-egress.js'
import { MeetingSettingsService } from '../domain/recording-retention.js'
import { RecordingService } from '../domain/recording-service.js'
import { TranscriptService } from '../domain/transcript-service.js'

const IdParam = z.object({ id: z.uuid() })

/**
 * Запись встречи и её расшифровка (11-communications-meetings.md §3–§4,
 * ADR-0092). Записью распоряжается тот, кто ведёт встречу и имеет способность
 * `meetings.record`; смотрят её участники встречи. Медиасервер докладывает
 * готовый файл вебхуком с подписью, движок — расшифровку служебным токеном.
 */
export function registerMeetingRecordingRoutes(route: RouteRegistrar): void {
  route({
    method: 'POST',
    url: '/meetings/:id/recording/start',
    auth: 'session',
    tags: ['meetings'],
    summary: 'Включить запись встречи: индикатор видят все участники',
    schema: { params: IdParam, response: { 200: RecordingRecord } },
    handler: async (request) => RecordingService.start(request.ctx, request.params.id),
  })

  route({
    method: 'POST',
    url: '/recordings/:id/stop',
    auth: 'session',
    tags: ['meetings'],
    summary: 'Остановить запись: файл медиасервер доложит сам',
    schema: { params: IdParam, response: { 200: RecordingRecord } },
    handler: async (request) => RecordingService.stop(request.ctx, request.params.id),
  })

  route({
    method: 'GET',
    url: '/meetings/:id/recordings',
    auth: 'session',
    tags: ['meetings'],
    summary: 'Записи встречи: доступны тем же, кому доступна встреча',
    schema: { params: IdParam, response: { 200: RecordingList } },
    handler: async (request) => ({
      items: await RecordingService.list(request.ctx, request.params.id),
    }),
  })

  route({
    method: 'GET',
    url: '/recordings/:id',
    auth: 'session',
    tags: ['meetings'],
    summary: 'Запись: состояние, файл, длительность, состояние расшифровки',
    schema: { params: IdParam, response: { 200: RecordingRecord } },
    handler: async (request) => RecordingService.get(request.ctx, request.params.id),
  })

  route({
    method: 'POST',
    url: '/recordings/:id/pin',
    auth: 'session',
    tags: ['meetings'],
    summary: 'Закрепить запись от удаления по сроку хранения или открепить (ADR-0138)',
    schema: { params: IdParam, body: RecordingPinInput, response: { 200: RecordingRecord } },
    handler: async (request) =>
      RecordingService.pin(request.ctx, request.params.id, request.body.pinned),
  })

  route({
    method: 'GET',
    url: '/admin/meetings/settings',
    auth: { capability: 'admin.system' },
    tags: ['meetings'],
    summary: 'Настройки встреч: срок хранения записей',
    schema: { response: { 200: MeetingSettings } },
    handler: async () => MeetingSettingsService.current(),
  })

  route({
    method: 'PUT',
    url: '/admin/meetings/settings',
    auth: { capability: 'admin.system' },
    tags: ['meetings'],
    summary: 'Изменить срок хранения записей встреч (0 — бессрочно)',
    schema: { body: MeetingSettings, response: { 200: MeetingSettings } },
    handler: async (request) =>
      db().transaction((tx) => MeetingSettingsService.update(tx, request.ctx, request.body)),
  })

  route({
    method: 'GET',
    url: '/recordings/:id/transcript',
    auth: 'session',
    tags: ['meetings'],
    summary: 'Расшифровка записи: сегменты с таймкодами',
    schema: { params: IdParam, response: { 200: TranscriptRecord } },
    handler: async (request) => TranscriptService.get(request.ctx, request.params.id),
  })

  // ─── Медиасервер (подпись ключом установки) ────────────────────────────────

  route({
    method: 'POST',
    url: '/meetings/webhooks/livekit',
    auth: 'public',
    tags: ['meetings'],
    summary: 'Медиасервер сообщает о записи: тело подписано ключом установки',
    // Счётчик на адрес: вебхук приходит из внутренней сети, поток невелик
    rateLimit: { max: 600, timeWindow: '1 minute' },
    schema: { response: { 200: z.object({ ok: z.literal(true), handled: z.boolean() }) } },
    handler: async (request) => {
      // Тело читается как текст: подпись считается по байтам, а не по разбору
      const raw = typeof request.body === 'string' ? request.body : JSON.stringify(request.body)
      const event = await verifyWebhook(raw, request.headers.authorization)
      const { handled } = await RecordingService.onWebhook(event)
      return { ok: true as const, handled }
    },
  })

  // ─── Движок (сервисный токен, внутренняя сеть) ─────────────────────────────

  route({
    method: 'POST',
    url: '/internal/meetings/recordings/:id/transcript',
    auth: 'public',
    tags: ['internal'],
    summary: 'Движок сообщает расшифровку записи',
    schema: {
      params: IdParam,
      body: TranscriptResult,
      response: { 200: z.object({ ok: z.literal(true) }) },
    },
    handler: async (request) => {
      if (!validServiceToken(request.headers['x-kchs-service-token'])) {
        throw errors.unauthorized('Недействительный сервисный токен')
      }
      await TranscriptService.save(request.params.id, request.body)
      return { ok: true as const }
    },
  })
}
