import type { PositionBatchInput, PositionBatchResult, PositionRejectReason } from '@kchs/contracts'
import { and, eq, inArray, isNull, lt, or } from 'drizzle-orm'
import { authorize } from '~/kernel/access/authorize.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import { objects } from '~/kernel/objects/schema.js'
import type { UserCtx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { devicePositions, devices } from '../schema.js'
import { checkPoints } from './checks.js'
import { PositionsSettingsService } from './settings.js'

interface DeviceInfo {
  id: string
  title: string
  spaceId: string | null
  active: boolean
  archived: boolean
  lastAt: string | null
  lastLat: number | null
  lastLon: number | null
}

/**
 * Приём пакета позиций (ADR-0203): поставщик мониторинга по токену с областью
 * `write:positions` или сотрудник с телефона группы в своей сессии.
 *
 *  - устройство ищется по внешнему номеру; право передавать — `authorize(report)`
 *    на устройство (передающему его даёт политика типа);
 *  - время из будущего, слишком давнее и невозможная скорость отбраковываются
 *    поточечно — пакет из-за одной плохой точки не теряется;
 *  - повтор той же точки (устройство + время) второй раз не пишется: ключ журнала;
 *  - новая последняя точка обновляет устройство и публикует `device.located` —
 *    одно событие на устройство за пакет, в той же транзакции.
 */
export const PositionIngest = {
  async accept(
    ctx: UserCtx,
    input: PositionBatchInput,
    source: 'token' | 'session',
  ): Promise<PositionBatchResult> {
    const now = Date.now()
    const externalIds = [...new Set(input.positions.map((point) => point.deviceId))]
    const rows = await db()
      .select({
        id: devices.id,
        externalId: devices.externalId,
        active: devices.active,
        lastAt: devices.lastAt,
        lastLat: devices.lastLat,
        lastLon: devices.lastLon,
        title: objects.title,
        spaceId: objects.spaceId,
        archivedAt: objects.archivedAt,
      })
      .from(devices)
      .innerJoin(objects, eq(objects.id, devices.id))
      .where(and(inArray(devices.externalId, externalIds), isNull(objects.deletedAt)))
    const known = new Map<string, DeviceInfo>(
      rows.map((row) => [
        row.externalId,
        {
          id: row.id,
          title: row.title,
          spaceId: row.spaceId,
          active: row.active,
          archived: row.archivedAt !== null,
          lastAt: row.lastAt,
          lastLat: row.lastLat,
          lastLon: row.lastLon,
        },
      ]),
    )
    const allowed = new Map<string, boolean>()
    for (const device of known.values()) {
      const decision = await authorize(ctx, 'report', device.id, { soft: true })
      allowed.set(device.id, decision.allowed)
    }

    const rejected: PositionBatchResult['rejected'] = []
    const reject = (index: number, deviceId: string, reason: PositionRejectReason) =>
      rejected.push({ index, deviceId, reason })
    const candidates = input.positions.flatMap((point, index) => {
      const device = known.get(point.deviceId)
      if (!device) {
        reject(index, point.deviceId, 'unknown_device')
        return []
      }
      // Чужое устройство — та же отметка, что у незаведённого: номер не подтверждается
      if (!allowed.get(device.id)) {
        reject(index, point.deviceId, 'unknown_device')
        return []
      }
      if (!device.active || device.archived) {
        reject(index, point.deviceId, 'inactive_device')
        return []
      }
      return [{ index, point, device }]
    })
    const previous = new Map(
      [...known.values()]
        .filter((device) => device.lastAt && device.lastLat !== null && device.lastLon !== null)
        .map((device) => [
          device.id,
          {
            at: Date.parse(device.lastAt as string),
            lat: device.lastLat as number,
            lon: device.lastLon as number,
          },
        ]),
    )
    const failed = checkPoints(
      candidates.map(({ index, point, device }) => ({
        index,
        device: device.id,
        at: Date.parse(point.at),
        lat: point.lat,
        lon: point.lon,
        speed: point.speed ?? null,
      })),
      previous,
      now,
    )
    const accepted = candidates.filter(({ index, point }) => {
      const reason = failed.get(index)
      if (reason) reject(index, point.deviceId, reason)
      return !reason
    })
    rejected.sort((a, b) => a.index - b.index)
    if (accepted.length === 0) return { accepted: 0, duplicates: 0, rejected }

    const settings = await PositionsSettingsService.current()
    const inserted = await db().transaction(async (tx) => {
      const written = await tx
        .insert(devicePositions)
        .values(
          accepted.map(({ point, device }) => ({
            deviceId: device.id,
            at: new Date(point.at).toISOString(),
            lat: point.lat,
            lon: point.lon,
            speed: point.speed ?? null,
            heading: point.heading ?? null,
            battery: point.battery ?? null,
            source,
          })),
        )
        .onConflictDoNothing()
        .returning({ deviceId: devicePositions.deviceId, at: devicePositions.at })

      // Последняя точка каждого устройства из записанных — если она новее известной
      const counts = new Map<string, number>()
      const newest = new Map<string, (typeof accepted)[number]>()
      const writtenKeys = new Set(written.map((row) => `${row.deviceId}|${Date.parse(row.at)}`))
      for (const entry of accepted) {
        const key = `${entry.device.id}|${Date.parse(entry.point.at)}`
        if (!writtenKeys.has(key)) continue
        writtenKeys.delete(key)
        counts.set(entry.device.id, (counts.get(entry.device.id) ?? 0) + 1)
        const current = newest.get(entry.device.id)
        if (!current || Date.parse(entry.point.at) > Date.parse(current.point.at)) {
          newest.set(entry.device.id, entry)
        }
      }
      for (const [deviceId, { point, device }] of newest) {
        const at = new Date(point.at).toISOString()
        // Условием, а не по прочитанному: два пакета одного устройства подряд не
        // откатят последнюю точку назад
        const moved = await tx
          .update(devices)
          .set({
            lastAt: at,
            lastLat: point.lat,
            lastLon: point.lon,
            lastSpeed: point.speed ?? null,
            lastHeading: point.heading ?? null,
            lastBattery: point.battery ?? null,
          })
          .where(and(eq(devices.id, deviceId), or(isNull(devices.lastAt), lt(devices.lastAt, at))))
          .returning({ id: devices.id })
        if (moved.length === 0) continue
        await publishEvent(tx, ctx, {
          type: 'device.located',
          object: { id: deviceId, type: 'device', spaceId: device.spaceId, title: device.title },
          payload: {
            at,
            lat: point.lat,
            lon: point.lon,
            speed: point.speed ?? null,
            heading: point.heading ?? null,
            battery: point.battery ?? null,
            points: counts.get(deviceId) ?? 1,
            datasetId: settings.projectionDatasetId,
          },
        })
      }
      return written.length
    })
    return { accepted: inserted, duplicates: accepted.length - inserted, rejected }
  },
}
