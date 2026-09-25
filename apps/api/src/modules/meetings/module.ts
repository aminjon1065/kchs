import type { ObjectSummary } from '@kchs/contracts'
import { inArray } from 'drizzle-orm'
import { registerCollabType } from '~/kernel/collab/registry.js'
import { registerSubscriber } from '~/kernel/events/bus.js'
import { registerFeature } from '~/kernel/features/registry.js'
import { registerJobHandler } from '~/kernel/jobs/runner.js'
import { registerObjectType } from '~/kernel/objects/registry.js'
import { declareSchedule } from '~/kernel/schedules/index.js'
import { DocumentsPrint } from '~/modules/documents/public.js'
import { db } from '~/shared/db/client.js'
import { meetings, recordings } from '~/shared/db/schema/index.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { registerMeetingRealtime } from './domain/meeting-subscribers.js'
import { protocolPrintForm } from './domain/protocol-print.js'
import { ProtocolService } from './domain/protocol-service.js'
import { protocolSubscribers } from './domain/protocol-subscribers.js'
import { setTranscriptSource } from './domain/protocol-transcript.js'
import { RecordingRetention } from './domain/recording-retention.js'
import { TranscriptService } from './domain/transcript-service.js'
import { registerMeetingsGuestRoutes } from './http/guest-routes.js'
import { registerMeetingRecordingRoutes } from './http/recording-routes.js'
import { registerMeetingsRoomRoutes } from './http/room-routes.js'
import { registerMeetingsRoutes as registerCoreRoutes } from './http.js'

/**
 * Маршруты встреч: ядро модуля, гостевой вход и комната ожидания (ADR-0091),
 * запись и расшифровка (ADR-0092), протокол (ADR-0093).
 */
export function registerMeetingsRoutes(route: RouteRegistrar): void {
  registerCoreRoutes(route)
  registerMeetingsGuestRoutes(route)
  registerMeetingsRoomRoutes(route)
  registerMeetingRecordingRoutes(route)
}

/**
 * Тип `meeting` (11-communications-meetings.md §3, ADR-0089) — при старте в
 * любой роли: HTTP проверяет права, воркер — подписчиков. Организатор владеет
 * встречей, приглашённые видят её участием (тихие записи ACL), чат встречи —
 * обсуждение её объекта.
 */
export function registerMeetingsObjectTypes(): void {
  registerFeature({
    key: 'meetings',
    titleKey: 'admin.features.items.meetings.title',
    hintKey: 'admin.features.items.meetings.hint',
    tags: ['meetings'],
    screens: ['meetings'],
    objectTypes: ['meeting', 'protocol', 'recording'],
  })

  registerObjectType({
    type: 'meeting',
    labelKey: 'objects.types.meeting',
    icon: 'meeting',
    route: (id) => `/o/${id}`,
    levels: ['view', 'comment', 'edit', 'manage', 'owner'],
    actions: {
      view: { minLevel: 'view' },
      /** Чат встречи — обсуждение объекта. */
      comment: { minLevel: 'comment' },
      /** Войти в комнату: приглашённый участник. */
      join: { minLevel: 'comment' },
      edit: { minLevel: 'edit' },
      /** Завершить для всех и вести встречу — организатор. */
      end: { minLevel: 'manage' },
      manage: { minLevel: 'manage' },
      share: { minLevel: 'manage' },
      delete: { minLevel: 'owner' },
    },
    discussable: true,
    linkable: true,
    hasParentTree: false,
    moduleManaged: true,
    summary: async (ids) => {
      const rows = await db()
        .select({
          id: meetings.id,
          kind: meetings.kind,
          status: meetings.status,
          startsAt: meetings.startsAt,
        })
        .from(meetings)
        .where(inArray(meetings.id, ids))
      return new Map(
        rows.map((row) => [
          row.id,
          {
            meta: { kind: row.kind, status: row.status, startsAt: row.startsAt },
          } as Partial<ObjectSummary>,
        ]),
      )
    },
  })

  registerRecordingType()
  registerProtocolType()
  // Печатная форма протокола: при регистрации документом — первая версия (N32)
  DocumentsPrint.register(protocolPrintForm)

  // Черновик протокола читает расшифровку записи через порт (ADR-0093):
  // источник — своя часть модуля, поэтому подключается при регистрации типов
  setTranscriptSource({ textOf: (meetingId, limit) => TranscriptService.textOf(meetingId, limit) })
}

/**
 * Тип `recording` (11-communications-meetings.md §3, ADR-0092): запись —
 * ребёнок своей встречи, поэтому её видит тот, кто видит встречу, а
 * посторонний получает 404. Сам файл записи — вложение этого объекта.
 */
function registerRecordingType(): void {
  registerObjectType({
    type: 'recording',
    labelKey: 'objects.types.recording',
    icon: 'recording',
    route: (id) => `/o/${id}`,
    levels: ['view', 'comment', 'edit', 'manage', 'owner'],
    actions: {
      view: { minLevel: 'view' },
      comment: { minLevel: 'comment' },
      edit: { minLevel: 'edit' },
      share: { minLevel: 'manage' },
      delete: { minLevel: 'owner' },
    },
    discussable: true,
    linkable: true,
    hasParentTree: false,
    moduleManaged: true,
    summary: async (ids) => {
      const rows = await db()
        .select({
          id: recordings.id,
          status: recordings.status,
          durationS: recordings.durationS,
          transcriptStatus: recordings.transcriptStatus,
        })
        .from(recordings)
        .where(inArray(recordings.id, ids))
      return new Map(
        rows.map((row) => [
          row.id,
          {
            meta: {
              status: row.status,
              durationS: row.durationS,
              transcriptStatus: row.transcriptStatus,
            },
          } as Partial<ObjectSummary>,
        ]),
      )
    },
  })
}

/**
 * Тип `protocol` (11-communications-meetings.md §4, ADR-0093, ADR-0137) —
 * ребёнок встречи: права наследуются от неё. Участник встречи (уровень
 * `comment`) читает и обсуждает протокол; правят организатор и секретарь
 * (своя запись `edit` на протоколе); подтверждение, регистрация документом и
 * ознакомление — за организатором (`manage`).
 */
function registerProtocolType(): void {
  registerObjectType({
    type: 'protocol',
    labelKey: 'objects.types.protocol',
    icon: 'protocol',
    route: (id) => `/o/${id}`,
    levels: ['view', 'comment', 'edit', 'manage', 'owner'],
    actions: {
      view: { minLevel: 'view' },
      comment: { minLevel: 'comment' },
      /** Совместная правка протокола — организатору и секретарю встречи (N30). */
      edit: { minLevel: 'edit' },
      manage: { minLevel: 'manage' },
      request_acknowledgment: { minLevel: 'manage', allowArchived: true },
      share: { minLevel: 'manage' },
      delete: { minLevel: 'owner' },
    },
    discussable: true,
    linkable: true,
    hasParentTree: false,
    moduleManaged: true,
    searchable: (id) => ProtocolService.searchable(id),
  })

  registerCollabType({
    type: 'protocol',
    initialState: (id, executor) => ProtocolService.initialState(id, executor),
    snapshot: (tx, ctx, id, doc) => ProtocolService.snapshot(tx, ctx, id, doc),
  })
}

/** Подписчики встреч, звонков и протокола, срок хранения записей — только в роли worker. */
export function registerMeetingsBackground(): void {
  registerMeetingRealtime()
  for (const subscriber of protocolSubscribers) registerSubscriber(subscriber)

  registerJobHandler({
    queue: 'maintenance',
    name: 'meetings.recordings-retention',
    concurrency: 1,
    handle: async () => ({ ...(await RecordingRetention.run()) }),
  })
}

/** Регулярные задания встреч — через единый планировщик ядра (ADR-0096). */
export function scheduleMeetingsJobs(): void {
  declareSchedule({
    queue: 'maintenance',
    name: 'meetings.recordings-retention',
    // Раз в сутки ночью: предупреждение за неделю и удаление записей по сроку (N29)
    pattern: '25 3 * * *',
    labelKey: 'schedules.jobs.recordingsRetention',
  })
}
