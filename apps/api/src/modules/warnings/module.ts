import { CAP_MSG_TYPES, CAP_SEVERITIES, WARNING_STATUSES } from '@kchs/contracts'
import { eq, sql } from 'drizzle-orm'
import { registerSubscriber } from '~/kernel/events/bus.js'
import { registerObjectType } from '~/kernel/objects/registry.js'
import { objects } from '~/kernel/objects/schema.js'
import { withProcessParticipants } from '~/kernel/process/index.js'
import { db } from '~/shared/db/client.js'
import { errors } from '~/shared/errors.js'
import { registerWarningProcess } from './domain/process.js'
import { warningSubscribers } from './domain/subscribers.js'
import { infosOf } from './domain/warning-store.js'
import { warnings } from './schema.js'

export { registerWarningRoutes } from './http.js'

/**
 * Предупреждения в формате CAP 1.2 (ADR-0202). Предупреждение — объект реестра:
 * права пространства, поиск, обсуждение и связи — общие. Участник маршрута
 * выпуска (подписывающий, заместитель) видит предупреждение и обсуждает его, пока
 * шаг идёт. Опубликованное не удаляется: его уточняют или отменяют новым.
 */
export function registerWarningObjectTypes(): void {
  registerObjectType({
    type: 'warning',
    labelKey: 'objects.types.warning',
    icon: 'siren',
    route: (id) => `/o/${id}`,
    levels: ['view', 'comment', 'edit', 'manage', 'owner'],
    actions: {
      view: { minLevel: 'view' },
      comment: { minLevel: 'comment' },
      edit: { minLevel: 'edit' },
      manage: { minLevel: 'manage' },
      share: { minLevel: 'manage' },
      delete: { minLevel: 'manage' },
    },
    discussable: true,
    linkable: true,
    hasParentTree: false,
    moduleManaged: true,
    policy: withProcessParticipants(undefined, { afterStep: 'view', activeLevel: 'comment' }),
    listFields: [
      {
        key: 'status',
        labelKey: 'warnings.fields.status',
        type: 'select',
        sql: sql`${objects.meta}->>'status'`,
        sortable: true,
        options: WARNING_STATUSES.map((value) => ({
          value,
          labelKey: `warnings.status.${value}`,
        })),
      },
      {
        key: 'severity',
        labelKey: 'warnings.fields.severity',
        type: 'select',
        sql: sql`${objects.meta}->>'severity'`,
        options: CAP_SEVERITIES.map((value) => ({
          value,
          labelKey: `warnings.severity.${value}`,
        })),
      },
      {
        key: 'msgType',
        labelKey: 'warnings.fields.msgType',
        type: 'select',
        sql: sql`${objects.meta}->>'msgType'`,
        options: CAP_MSG_TYPES.map((value) => ({
          value,
          labelKey: `warnings.msgType.${value}`,
        })),
      },
    ],
    searchable: async (id) => {
      const [row] = await db()
        .select({
          info: warnings.info,
          title: objects.title,
          spaceId: objects.spaceId,
          ownerId: objects.ownerId,
          parentId: objects.parentId,
          updatedAt: objects.updatedAt,
        })
        .from(warnings)
        .innerJoin(objects, eq(objects.id, warnings.id))
        .where(eq(warnings.id, id))
        .limit(1)
      if (!row) return null
      const infos = infosOf(row as never)
      const body = (['ru', 'tg', 'en'] as const)
        .map((language) => {
          const info = infos[language]
          return info ? [info.event, info.description, info.instruction].join('\n') : ''
        })
        .join('\n')
      return {
        parentId: row.parentId,
        type: 'warning' as const,
        spaceId: row.spaceId,
        title: row.title,
        body: body.slice(0, 4000),
        ownerId: row.ownerId,
        updatedAt: Math.floor(new Date(row.updatedAt).getTime() / 1000),
        meta: {},
      }
    },
    lifecycle: {
      // Выпущенное наружу не исчезает: его уточняют или отменяют новым предупреждением
      beforeTrash: async (tx, _ctx, object) => {
        const [row] = await tx
          .select({ status: warnings.status })
          .from(warnings)
          .where(eq(warnings.id, object.id))
          .limit(1)
        if (row && row.status !== 'draft') {
          throw errors.conflict('Удаляется только черновик предупреждения')
        }
      },
    },
  })
  registerWarningProcess()
}

/** Журнал решений дежурного по `warning.published` — только в роли worker. */
export function registerWarningsBackground(): void {
  for (const subscriber of warningSubscribers) registerSubscriber(subscriber)
}
