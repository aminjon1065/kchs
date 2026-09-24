import { grantAccess } from '~/kernel/access/acl-service.js'
import { bumpPrincipalsVersion } from '~/kernel/access/principal-set.js'
import { db } from '~/shared/db/client.js'
import { logger } from '~/shared/logger/index.js'
import { type PackContext, packContext } from './context.js'
import { ensureDashboards } from './dashboards.js'
import { ensureDatasets, ensureIncidentKinds } from './datasets.js'
import { seedDemoRows } from './demo-rows.js'
import { ensureDocuments } from './documents.js'
import { ensureKnowledge } from './knowledge.js'
import { ensureMap } from './map.js'
import { ensureStructure, type PackGroupKey } from './structure.js'

export interface EmergencyPackResult {
  spaceId: string
  datasets: number
  mapId: string
  dashboards: number
  pages: number
}

/**
 * Права групп пакета на реестры: дежурная смена правит происшествия и уровни воды
 * (наносит на карту, исправляет) и решения по сообщениям; аналитики рисков — зоны риска.
 * Остальное — по ролям пространств. Выдача идемпотентна: та же запись ACL не дублируется.
 */
async function grantGroups(
  pack: PackContext,
  datasets: ReadonlyMap<string, string>,
  groups: Record<PackGroupKey, string>,
): Promise<void> {
  const edit: Array<[string, PackGroupKey]> = [
    ['incidents', 'duty'],
    ['water_levels', 'duty'],
    ['hazard_messages', 'duty'],
    ['shelters', 'duty'],
    ['warnings_log', 'duty'],
    ['duty_roster', 'duty'],
    ['risk_zones', 'analysts'],
    ['hazard_messages', 'analysts'],
  ]
  await db().transaction(async (tx) => {
    for (const [key, group] of edit) {
      const datasetId = datasets.get(key)
      if (!datasetId) continue
      await grantAccess(tx, pack.ctx, datasetId, [
        { principal: { type: 'group', id: groups[group] }, level: 'edit' },
      ])
    }
  })
}

/**
 * Установка предметного пакета «Чрезвычайные ситуации» (P5-E08, ADR-0128) —
 * `pnpm db:seed --pack=emergency`, `kchs seed --pack emergency`. Повторный запуск
 * досводит только недостающее: объекты находятся по ключам пакета.
 */
export async function installEmergencyPack(adminLogin: string): Promise<EmergencyPackResult> {
  const log = logger().child({ module: 'seed', pack: 'emergency' })
  const base = await packContext(adminLogin, (message, details) => log.info(details ?? {}, message))
  const structure = await ensureStructure(base)
  const pack: PackContext = { ...base, spaceId: structure.spaceId }

  const datasets = await ensureDatasets(pack)
  const kinds = await ensureIncidentKinds(pack, datasets.get('incident_types') as string)
  if (kinds > 0) log.info({ kinds }, 'справочник видов происшествий заполнен')
  await grantGroups(pack, datasets, structure.groupIds)
  await seedDemoRows(pack, datasets)

  const { mapId } = await ensureMap(pack, datasets)
  const { dashboards } = await ensureDashboards(pack, datasets, mapId)
  await ensureDocuments(pack, { duty: structure.groupIds.duty })
  const pages = await ensureKnowledge(pack)
  await bumpPrincipalsVersion()

  const result = {
    spaceId: pack.spaceId,
    datasets: datasets.size,
    mapId,
    dashboards: dashboards.size,
    pages,
  }
  log.info(result, 'пакет ЧС установлен')
  return result
}
