import { db } from '~/shared/db/client.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { verifyWebhook } from '../domain/recording-egress.js'
import { MeetingSettingsService } from '../domain/recording-retention.js'
import { RecordingService } from '../domain/recording-service.js'
import { TranscriptService } from '../domain/transcript-service.js'

/**
 * Запись встречи и её расшифровка (11-communications-meetings.md §3–§4,
 * ADR-0092). Записью распоряжается тот, кто ведёт встречу и имеет способность
 * `meetings.record`; смотрят её участники встречи. Медиасервер докладывает
 * готовый файл вебхуком с подписью, движок — расшифровку служебным токеном.
 */
export function registerMeetingRecordingRoutes(route: RouteRegistrar): void {
  route({
    route: 'POST /meetings/:id/recording/start',
    auth: { delegated: 'RecordingService.start', objectType: 'meeting' },
    tags: ['meetings'],
    summary: 'Включить запись встречи: индикатор видят все участники',
    handler: async (request) => RecordingService.start(request.ctx, request.params.id),
  })

  route({
    route: 'POST /recordings/:id/stop',
    auth: { delegated: 'RecordingService.stop', objectType: 'recording' },
    tags: ['meetings'],
    summary: 'Остановить запись: файл медиасервер доложит сам',
    handler: async (request) => RecordingService.stop(request.ctx, request.params.id),
  })

  route({
    route: 'GET /meetings/:id/recordings',
    auth: { delegated: 'RecordingService.list', objectType: 'meeting' },
    tags: ['meetings'],
    summary: 'Записи встречи: доступны тем же, кому доступна встреча',
    handler: async (request) => ({
      items: await RecordingService.list(request.ctx, request.params.id),
    }),
  })

  route({
    route: 'GET /recordings/:id',
    auth: { delegated: 'RecordingService.get', objectType: 'recording' },
    tags: ['meetings'],
    summary: 'Запись: состояние, файл, длительность, состояние расшифровки',
    handler: async (request) => RecordingService.get(request.ctx, request.params.id),
  })

  route({
    route: 'POST /recordings/:id/pin',
    auth: { delegated: 'RecordingService.pin', objectType: 'recording' },
    tags: ['meetings'],
    summary: 'Закрепить запись от удаления по сроку хранения или открепить (ADR-0138)',
    handler: async (request) =>
      RecordingService.pin(request.ctx, request.params.id, request.body.pinned),
  })

  route({
    route: 'GET /admin/meetings/settings',
    auth: { capability: 'admin.system' },
    tags: ['meetings'],
    summary: 'Настройки встреч: срок хранения записей',
    handler: async () => MeetingSettingsService.current(),
  })

  route({
    route: 'PUT /admin/meetings/settings',
    auth: { capability: 'admin.system' },
    tags: ['meetings'],
    summary: 'Изменить срок хранения записей встреч (0 — бессрочно)',
    handler: async (request) =>
      db().transaction((tx) => MeetingSettingsService.update(tx, request.ctx, request.body)),
  })

  route({
    route: 'GET /recordings/:id/transcript',
    auth: { delegated: 'TranscriptService.get', objectType: 'recording' },
    tags: ['meetings'],
    summary: 'Расшифровка записи: сегменты с таймкодами',
    handler: async (request) => TranscriptService.get(request.ctx, request.params.id),
  })

  route({
    route: 'PATCH /recordings/:id/transcript/segments/:index',
    auth: { delegated: 'TranscriptService.editSegment', objectType: 'recording' },
    tags: ['meetings'],
    summary: 'Исправить текст фразы расшифровки (ADR-0162)',
    handler: async (request) =>
      TranscriptService.editSegment(
        request.ctx,
        request.params.id,
        request.params.index,
        request.body.text,
      ),
  })

  route({
    route: 'PUT /recordings/:id/transcript/speakers',
    auth: { delegated: 'TranscriptService.setSpeaker', objectType: 'recording' },
    tags: ['meetings'],
    summary: 'Сопоставить говорящего расшифровки с участником встречи (ADR-0162)',
    handler: async (request) =>
      TranscriptService.setSpeaker(
        request.ctx,
        request.params.id,
        request.body.label,
        request.body.userId,
      ),
  })

  // ─── Медиасервер (подпись ключом установки) ────────────────────────────────

  route({
    route: 'POST /meetings/webhooks/livekit',
    auth: 'public',
    tags: ['meetings'],
    summary: 'Медиасервер сообщает о записи: тело подписано ключом установки',
    // Счётчик на адрес: вебхук приходит из внутренней сети, поток невелик
    rateLimit: { max: 600, timeWindow: '1 minute' },
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
    route: 'POST /internal/meetings/recordings/:id/transcript',
    auth: { engineJob: { scope: (params) => `recording:${params.id}` } },
    tags: ['internal'],
    summary: 'Движок сообщает расшифровку записи',
    handler: async (request) => {
      await TranscriptService.save(request.params.id, request.body)
      return { ok: true as const }
    },
  })
}
