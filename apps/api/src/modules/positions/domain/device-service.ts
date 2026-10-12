import type {
  DeviceCreateInput,
  DeviceKind,
  DeviceLinkState,
  DeviceList,
  DeviceListQuery,
  DeviceRecord,
  DeviceTrack,
  DeviceTrackQuery,
  DeviceUpdateInput,
  PositionFix,
  UserRef,
} from '@kchs/contracts'
import { and, desc, eq, gte, ilike, isNull, lte, or, type SQL, sql } from 'drizzle-orm'
import { authorize, visibleObjectsSql } from '~/kernel/access/authorize.js'
import { directory } from '~/kernel/directory/port.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import { objects } from '~/kernel/objects/schema.js'
import { ObjectService } from '~/kernel/objects/service.js'
import type { UserCtx } from '~/shared/context.js'
import { db, type Executor, type Tx } from '~/shared/db/client.js'
import { pgErrorCode, UNIQUE_VIOLATION } from '~/shared/db/pg-error.js'
import { errors } from '~/shared/errors.js'
import { devicePositions, devices } from '../schema.js'
import { PositionsSettingsService } from './settings.js'

const selection = {
  id: devices.id,
  externalId: devices.externalId,
  kind: devices.kind,
  forcesCode: devices.forcesCode,
  unitId: devices.unitId,
  reporterId: devices.reporterId,
  note: devices.note,
  active: devices.active,
  lastAt: devices.lastAt,
  lastLat: devices.lastLat,
  lastLon: devices.lastLon,
  lastSpeed: devices.lastSpeed,
  lastHeading: devices.lastHeading,
  lastBattery: devices.lastBattery,
  createdAt: devices.createdAt,
  updatedAt: devices.updatedAt,
  title: objects.title,
  spaceId: objects.spaceId,
  archivedAt: objects.archivedAt,
}

type Row = {
  [K in keyof typeof selection]: (typeof selection)[K]['_']['data'] | null
} & { id: string; externalId: string; kind: string; active: boolean; title: string }

/** Последняя точка из столбцов устройства. */
function lastFix(row: Row): PositionFix | null {
  if (!row.lastAt || row.lastLat === null || row.lastLon === null) return null
  return {
    at: row.lastAt,
    lat: row.lastLat,
    lon: row.lastLon,
    speed: row.lastSpeed,
    heading: row.lastHeading,
    battery: row.lastBattery,
  }
}

/** «На связи», «нет связи», «не выходило» — по свежести последней точки. */
export function linkState(lastAt: string | null, staleMinutes: number, now = Date.now()) {
  if (!lastAt) return 'never' as DeviceLinkState
  return (now - Date.parse(lastAt) <= staleMinutes * 60_000 ? 'online' : 'stale') as DeviceLinkState
}

async function toRecord(
  ctx: UserCtx,
  row: Row,
  staleMinutes: number,
  people: ReadonlyMap<string, UserRef>,
): Promise<DeviceRecord> {
  const [edit, report] = await Promise.all([
    authorize(ctx, 'edit', row.id, { soft: true }).then((d) => d.allowed),
    authorize(ctx, 'report', row.id, { soft: true }).then((d) => d.allowed),
  ])
  return {
    id: row.id,
    spaceId: row.spaceId ?? '',
    name: row.title,
    externalId: row.externalId,
    kind: row.kind as DeviceKind,
    forcesCode: row.forcesCode,
    unitId: row.unitId,
    reporter: row.reporterId ? (people.get(row.reporterId) ?? null) : null,
    note: row.note,
    active: row.active,
    last: lastFix(row),
    link: linkState(row.lastAt, staleMinutes),
    createdAt: row.createdAt ?? new Date().toISOString(),
    updatedAt: row.updatedAt ?? new Date().toISOString(),
    can: { edit, report },
  }
}

async function load(executor: Executor, id: string): Promise<Row | null> {
  const [row] = await executor
    .select(selection)
    .from(devices)
    .innerJoin(objects, eq(objects.id, devices.id))
    .where(and(eq(devices.id, id), isNull(objects.deletedAt)))
    .limit(1)
  return (row as Row | undefined) ?? null
}

/** Сводка объекта для поиска и шапки: внешний номер — подзаголовок, вид — в meta. */
function objectMeta(input: { kind: string; externalId: string; active: boolean }) {
  return { kind: input.kind, externalId: input.externalId, active: input.active }
}

/** Ответственный за передачу — существующий действующий сотрудник или служебная запись. */
async function assertReporter(reporterId: string | null | undefined): Promise<void> {
  if (!reporterId) return
  const refs = await directory().refs([reporterId])
  if (!refs.has(reporterId)) {
    throw errors.validation('Кто передаёт координаты — не найден', [
      { path: 'reporterId', message: 'not_found' },
    ])
  }
}

function conflictOnExternal(error: unknown): never {
  if (pgErrorCode(error) === UNIQUE_VIOLATION) {
    throw errors.conflict('Устройство с таким номером уже заведено (возможно, оно в корзине)', {
      field: 'externalId',
    })
  }
  throw error
}

/**
 * Устройства слежения (ADR-0203): реестр с правами объекта. Заводит и правит
 * карточку управляющий пространством; передающий координаты получает право
 * передавать их по политике типа — других прав в пространстве ему не нужно.
 */
export const DeviceService = {
  async create(tx: Tx, ctx: UserCtx, input: DeviceCreateInput): Promise<string> {
    await assertReporter(input.reporterId)
    const object = await ObjectService.create(tx, ctx, {
      type: 'device',
      spaceId: input.spaceId,
      title: input.name,
      subtitle: input.externalId,
      icon: 'device',
      meta: objectMeta({ kind: input.kind, externalId: input.externalId, active: true }),
    })
    try {
      await tx.insert(devices).values({
        id: object.id,
        externalId: input.externalId,
        kind: input.kind,
        forcesCode: input.forcesCode ?? null,
        unitId: input.unitId ?? null,
        reporterId: input.reporterId ?? null,
        note: input.note ?? null,
      })
    } catch (error) {
      conflictOnExternal(error)
    }
    await publishEvent(tx, ctx, {
      type: 'device.created',
      object: { id: object.id, type: 'device', spaceId: input.spaceId, title: input.name },
      payload: { externalId: input.externalId, kind: input.kind },
    })
    return object.id
  },

  async update(tx: Tx, ctx: UserCtx, id: string, input: DeviceUpdateInput): Promise<void> {
    const row = await load(tx, id)
    if (!row) throw errors.notFound('Устройство')
    if (input.reporterId !== undefined) await assertReporter(input.reporterId)
    const patch: Partial<typeof devices.$inferInsert> = {}
    const changed: string[] = []
    const set = <K extends keyof typeof devices.$inferInsert>(
      key: K,
      value: (typeof devices.$inferInsert)[K] | undefined,
      current: unknown,
    ) => {
      if (value === undefined || value === current) return
      patch[key] = value
      changed.push(key)
    }
    set('externalId', input.externalId, row.externalId)
    set('kind', input.kind, row.kind)
    set('forcesCode', input.forcesCode, row.forcesCode)
    set('unitId', input.unitId, row.unitId)
    set('reporterId', input.reporterId, row.reporterId)
    set('note', input.note, row.note)
    set('active', input.active, row.active)
    const renamed = input.name !== undefined && input.name !== row.title
    if (renamed) changed.push('name')
    if (changed.length === 0) return

    if (Object.keys(patch).length > 0) {
      try {
        await tx
          .update(devices)
          .set({ ...patch, updatedAt: sql`now()` })
          .where(eq(devices.id, id))
      } catch (error) {
        conflictOnExternal(error)
      }
    }
    await ObjectService.update(tx, ctx, id, {
      ...(renamed ? { title: input.name } : {}),
      subtitle: input.externalId ?? row.externalId,
      meta: objectMeta({
        kind: input.kind ?? row.kind,
        externalId: input.externalId ?? row.externalId,
        active: input.active ?? row.active,
      }),
      mergeMeta: true,
    })
    await publishEvent(tx, ctx, {
      type: 'device.updated',
      object: { id, type: 'device', spaceId: row.spaceId, title: input.name ?? row.title },
      payload: { changed },
    })
  },

  async get(ctx: UserCtx, id: string): Promise<DeviceRecord> {
    await authorize(ctx, 'view', id)
    const row = await load(db(), id)
    if (!row) throw errors.notFound('Устройство')
    const [settings, people] = await Promise.all([
      PositionsSettingsService.current(),
      directory().refs(row.reporterId ? [row.reporterId] : []),
    ])
    return toRecord(ctx, row, settings.staleMinutes, people)
  },

  async list(ctx: UserCtx, query: DeviceListQuery): Promise<DeviceList> {
    const conditions: SQL[] = [isNull(objects.deletedAt), visibleObjectsSql(ctx, 'device')]
    if (query.spaceId) conditions.push(eq(objects.spaceId, query.spaceId))
    if (query.q) {
      const like = `%${query.q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`
      conditions.push(or(ilike(objects.title, like), ilike(devices.externalId, like)) as SQL)
    }
    const rows = (await db()
      .select(selection)
      .from(devices)
      .innerJoin(objects, eq(objects.id, devices.id))
      .where(and(...conditions))
      .orderBy(objects.title)
      .limit(query.limit)) as Row[]
    const [settings, people] = await Promise.all([
      PositionsSettingsService.current(),
      directory().refs([
        ...new Set(rows.map((row) => row.reporterId).filter((id): id is string => !!id)),
      ]),
    ])
    return {
      items: await Promise.all(
        rows.map((row) => toRecord(ctx, row, settings.staleMinutes, people)),
      ),
      staleMinutes: settings.staleMinutes,
    }
  },

  /** Трек устройства за период: последние точки до предела, по времени. */
  async track(ctx: UserCtx, id: string, query: DeviceTrackQuery): Promise<DeviceTrack> {
    await authorize(ctx, 'view', id)
    const conditions: SQL[] = [eq(devicePositions.deviceId, id)]
    if (query.from) conditions.push(gte(devicePositions.at, query.from))
    if (query.to) conditions.push(lte(devicePositions.at, query.to))
    const rows = await db()
      .select({
        at: devicePositions.at,
        lat: devicePositions.lat,
        lon: devicePositions.lon,
        speed: devicePositions.speed,
        heading: devicePositions.heading,
        battery: devicePositions.battery,
      })
      .from(devicePositions)
      .where(and(...conditions))
      .orderBy(desc(devicePositions.at))
      .limit(query.limit + 1)
    const truncated = rows.length > query.limit
    return {
      deviceId: id,
      points: rows.slice(0, query.limit).reverse(),
      truncated,
    }
  },
}
