import type { ObjectSummary } from '@kchs/contracts'
import { inArray } from 'drizzle-orm'
import { registerObjectType } from '~/kernel/objects/registry.js'
import { db } from '~/shared/db/client.js'
import { meetings, recordings } from '~/shared/db/schema/index.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { registerMeetingRecordingRoutes } from './http/recording-routes.js'
import { registerMeetingsRoutes as registerCoreRoutes } from './http.js'

export function registerMeetingsRoutes(route: RouteRegistrar): void {
  registerCoreRoutes(route)
  registerMeetingRecordingRoutes(route)
}

/**
 * Тип `meeting` (11-communications-meetings.md §3, ADR-0089) — при старте в
 * любой роли: HTTP проверяет права, воркер — подписчиков. Организатор владеет
 * встречей, приглашённые видят её участием (тихие записи ACL), чат встречи —
 * обсуждение её объекта.
 */
export function registerMeetingsObjectTypes(): void {
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

  /**
   * Тип `recording` (11-communications-meetings.md §3, ADR-0092): запись —
   * ребёнок своей встречи, поэтому её видит тот, кто видит встречу, а
   * посторонний получает 404. Сам файл записи — вложение этого объекта.
   */
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
