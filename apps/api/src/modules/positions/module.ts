import { DEVICE_KINDS } from '@kchs/contracts'
import { eq, sql } from 'drizzle-orm'
import { registerJobHandler } from '~/kernel/jobs/runner.js'
import { registerObjectType } from '~/kernel/objects/registry.js'
import { objects } from '~/kernel/objects/schema.js'
import { declareSchedule } from '~/kernel/schedules/index.js'
import { db } from '~/shared/db/client.js'
import { devicePolicy } from './domain/device-policy.js'
import { PositionPartitions } from './domain/maintenance.js'
import { PositionProjection } from './domain/projection.js'
import { registerPositionSubscribers } from './domain/subscribers.js'
import { devices } from './schema.js'

export { registerPositionRoutes } from './http/routes.js'

/**
 * Местоположение сил и средств (концепт-нота КЧСиГО, компонент 5; ADR-0203).
 * Устройство слежения — объект реестра `device`: видит его тот, кто видит
 * пространство; передаёт координаты тот, кому это поручено в карточке
 * (политика типа) или у кого есть право правки; карточку правит управляющий.
 */
export function registerPositionsObjectTypes(): void {
  registerObjectType({
    type: 'device',
    labelKey: 'objects.types.device',
    icon: 'map-pin',
    route: (id) => `/o/${id}`,
    levels: ['view', 'comment', 'edit', 'manage', 'owner'],
    actions: {
      view: { minLevel: 'view' },
      /** Передавать координаты: передающему — по политике типа, остальным — правом правки. */
      report: { minLevel: 'edit' },
      edit: { minLevel: 'manage' },
      manage: { minLevel: 'manage' },
      share: { minLevel: 'manage' },
      delete: { minLevel: 'manage' },
    },
    discussable: true,
    linkable: true,
    hasParentTree: false,
    moduleManaged: true,
    policy: devicePolicy,
    listFields: [
      {
        key: 'kind',
        labelKey: 'positions.fields.kind',
        type: 'select',
        sql: sql`${objects.meta}->>'kind'`,
        options: DEVICE_KINDS.map((value) => ({ value, labelKey: `positions.kinds.${value}` })),
      },
      {
        key: 'active',
        labelKey: 'positions.fields.active',
        type: 'boolean',
        sql: sql`(${objects.meta}->>'active')::boolean`,
        sortable: true,
      },
    ],
    searchable: async (id) => {
      const [row] = await db()
        .select({
          title: objects.title,
          spaceId: objects.spaceId,
          ownerId: objects.ownerId,
          parentId: objects.parentId,
          updatedAt: objects.updatedAt,
          externalId: devices.externalId,
          forcesCode: devices.forcesCode,
          note: devices.note,
        })
        .from(devices)
        .innerJoin(objects, eq(objects.id, devices.id))
        .where(eq(devices.id, id))
        .limit(1)
      if (!row) return null
      return {
        parentId: row.parentId,
        type: 'device' as const,
        spaceId: row.spaceId,
        title: row.title,
        body: [row.externalId, row.forcesCode, row.note].filter(Boolean).join(' ').slice(0, 4000),
        ownerId: row.ownerId,
        updatedAt: Math.floor(new Date(row.updatedAt).getTime() / 1000),
        meta: {},
      }
    },
  })
}

/** Подписчики и задания обслуживания — только в роли worker. */
export function registerPositionsBackground(): void {
  registerPositionSubscribers()

  // Последние позиции — в датасет слоя карты обстановки, раз в минуту одной записью
  registerJobHandler({
    queue: 'maintenance',
    name: 'positions.project',
    concurrency: 1,
    handle: async () => ({ ...(await PositionProjection.run()) }),
  })

  // Партиции журнала точек вперёд и удаление месяцев старше срока хранения
  registerJobHandler({
    queue: 'maintenance',
    name: 'positions.partitions',
    concurrency: 1,
    handle: async () => ({ ...(await PositionPartitions.maintain()) }),
  })
}

/** Расписания объявляются во всех ролях процесса (ADR-0174). */
export function declarePositionsSchedules(): void {
  declareSchedule({
    queue: 'maintenance',
    name: 'positions.project',
    pattern: '* * * * *',
    labelKey: 'schedules.jobs.positionsProject',
  })
  declareSchedule({
    queue: 'maintenance',
    name: 'positions.partitions',
    pattern: '23 3 * * *',
    labelKey: 'schedules.jobs.positionsPartitions',
  })
}
