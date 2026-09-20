import type { ObjectSummary } from '@kchs/contracts'
import { inArray } from 'drizzle-orm'
import { registerCollabType } from '~/kernel/collab/registry.js'
import { registerSubscriber } from '~/kernel/events/bus.js'
import { registerObjectType } from '~/kernel/objects/registry.js'
import { db } from '~/shared/db/client.js'
import { meetings } from '~/shared/db/schema/index.js'
import { ProtocolService } from './domain/protocol-service.js'
import { protocolSubscribers } from './domain/protocol-subscribers.js'

export { registerMeetingsRoutes } from './http.js'

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

  registerProtocolType()
}

/**
 * Тип `protocol` (11-communications-meetings.md §4, ADR-0093) — ребёнок
 * встречи: права наследуются от неё, поэтому участник встречи (уровень
 * `comment`) ведёт повестку и протокол совместно, а подтверждение,
 * регистрация документом и ознакомление — за организатором (`manage`).
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
      /** Совместная правка документа протокола — участникам встречи. */
      edit: { minLevel: 'comment' },
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

/** Подписчики протокола — только в роли worker. */
export function registerMeetingsBackground(): void {
  for (const subscriber of protocolSubscribers) registerSubscriber(subscriber)
}
