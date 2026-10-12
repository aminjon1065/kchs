import { and, eq, gt, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm'
import { objects } from '~/kernel/objects/schema.js'
import { DatasetQueries, DatasetRows } from '~/modules/data/public.js'
import { systemCtx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { logger } from '~/shared/logger/index.js'
import { devices } from '../schema.js'
import { linkState } from './device-service.js'
import { PositionsSettingsService } from './settings.js'

/** За один проход — не больше: проход раз в минуту, хвост уйдёт следующим. */
const BATCH = 500

/**
 * Проекция последних позиций в датасет слоя карты обстановки (ADR-0203): строка
 * на устройство с ключом `code` = внешний номер. Пишется только через публичный
 * API модуля «Данные» — с проверками значений, историей и событием, как правка из
 * таблицы. Раз в минуту, а не на каждую точку: версия датасета (и кэш тайлов) не
 * меняется сотню раз в минуту, а карта обстановки обновляется раз в минуту и так.
 * Поля датасета, которых нет, пропускаются: администратор мог их убрать.
 */
export const PositionProjection = {
  async run(): Promise<{
    projected: number
    removed?: number
    skipped?: 'not_configured' | 'dataset_missing'
  }> {
    const settings = await PositionsSettingsService.current()
    const datasetId = settings.projectionDatasetId
    if (!datasetId) return { projected: 0, skipped: 'not_configured' }
    const ctx = systemCtx('positions.projection')
    const fields = await DatasetQueries.visibleFields(ctx, datasetId).catch(() => null)
    if (!fields?.has('code')) {
      logger().warn({ datasetId }, 'датасет проекции позиций без поля code — проекция пропущена')
      return { projected: 0, skipped: 'dataset_missing' }
    }
    const removed = await PositionProjection.removeGone(datasetId)
    const rows = await db()
      .select({
        id: devices.id,
        externalId: devices.externalId,
        kind: devices.kind,
        forcesCode: devices.forcesCode,
        unitId: devices.unitId,
        lastAt: devices.lastAt,
        lastLat: devices.lastLat,
        lastLon: devices.lastLon,
        lastSpeed: devices.lastSpeed,
        lastBattery: devices.lastBattery,
        title: objects.title,
      })
      .from(devices)
      .innerJoin(objects, eq(objects.id, devices.id))
      .where(
        and(
          isNull(objects.deletedAt),
          eq(devices.active, true),
          isNotNull(devices.lastAt),
          or(
            isNull(devices.projectedAt),
            gt(devices.lastAt, devices.projectedAt),
            // Замолчавшее устройство: в слое оно «на связи», а точка уже старше порога
            and(
              eq(devices.projectedLink, 'online'),
              lt(
                devices.lastAt,
                new Date(Date.now() - settings.staleMinutes * 60_000).toISOString(),
              ),
            ),
          ),
        ),
      )
      .limit(BATCH)
    if (rows.length === 0) return { projected: 0, removed }

    const now = Date.now()
    const links = new Map(
      rows.map((row) => [row.id, linkState(row.lastAt, settings.staleMinutes, now)]),
    )
    const values = rows.map((row) => {
      const all: Record<string, unknown> = {
        code: row.externalId,
        name: row.title,
        kind: row.kind,
        forces_code: row.forcesCode,
        unit: row.unitId,
        seen_at: row.lastAt,
        speed: row.lastSpeed,
        battery: row.lastBattery,
        link: links.get(row.id),
        geometry: { type: 'Point', coordinates: [row.lastLon, row.lastLat] },
      }
      return Object.fromEntries(Object.entries(all).filter(([key]) => fields.has(key)))
    })
    await db().transaction(async (tx) => {
      await DatasetRows.upsertByKey(tx, ctx, datasetId, 'code', values)
      for (const row of rows) {
        await tx
          .update(devices)
          .set({ projectedAt: sql`${row.lastAt}::timestamptz`, projectedLink: links.get(row.id) })
          .where(eq(devices.id, row.id))
      }
    })
    return { projected: rows.length, removed }
  },

  /**
   * Устройство в корзине или выключено — его строки в слое быть не должно: строка
   * удаляется по ключу, отметка проекции снимается (вернётся — запишется заново).
   */
  async removeGone(datasetId: string): Promise<number> {
    const gone = await db()
      .select({ id: devices.id, externalId: devices.externalId })
      .from(devices)
      .innerJoin(objects, eq(objects.id, devices.id))
      .where(
        and(
          isNotNull(devices.projectedAt),
          or(isNotNull(objects.deletedAt), eq(devices.active, false)),
        ),
      )
      .limit(BATCH)
    if (gone.length === 0) return 0
    const ctx = systemCtx('positions.projection')
    return db().transaction(async (tx) => {
      const count = await DatasetRows.removeByKey(
        tx,
        ctx,
        datasetId,
        'code',
        gone.map((row) => row.externalId),
      )
      await tx
        .update(devices)
        .set({ projectedAt: null, projectedLink: null })
        .where(
          inArray(
            devices.id,
            gone.map((row) => row.id),
          ),
        )
      return count
    })
  },
}
