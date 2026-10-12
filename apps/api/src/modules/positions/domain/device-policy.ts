import type { AccessReason } from '@kchs/contracts'
import { eq, sql } from 'drizzle-orm'
import type { TypePolicy } from '~/kernel/access/types.js'
import { objects } from '~/kernel/objects/schema.js'
import { db } from '~/shared/db/client.js'
import { devices } from '../schema.js'

const reporterReason: AccessReason = {
  kind: 'type_policy',
  level: 'edit',
  messageKey: 'access.reason.device_reporter',
  params: {},
  sourceObjectId: null,
}

/**
 * Политика типа `device` (03-access-model.md §5, ADR-0203): тот, кто передаёт
 * координаты устройства (служебная запись поставщика мониторинга или сотрудник
 * с телефоном группы), получает уровень `edit` — его хватает на действие
 * `report` и просмотр; правка карточки требует `manage`. Так поставщику не нужно
 * членство в пространстве штаба: он видит и пишет только свои устройства.
 */
export const devicePolicy: TypePolicy = {
  principals: async (object, executor) => {
    const [row] = await executor
      .select({ reporterId: devices.reporterId })
      .from(devices)
      .where(eq(devices.id, object.id))
      .limit(1)
    return row?.reporterId ? [`user:${row.reporterId}`] : []
  },

  derive: async (ctx, object) => {
    const [row] = await db()
      .select({ reporterId: devices.reporterId })
      .from(devices)
      .where(eq(devices.id, object.id))
      .limit(1)
    return row?.reporterId === ctx.userId ? [{ level: 'edit', reason: reporterReason }] : []
  },

  // EXISTS по первичному ключу устройств: свои устройства видны передающему в списках
  visibleSql: (ctx) =>
    sql`EXISTS (SELECT 1 FROM ${devices}
      WHERE ${devices.id} = ${objects.id} AND ${devices.reporterId} = ${ctx.userId})`,
}
