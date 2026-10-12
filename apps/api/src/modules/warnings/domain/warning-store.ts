import {
  type CapMsgType,
  type CapStatus,
  WARNING_LANGUAGES,
  type WarningArea,
  type WarningInfo,
  type WarningInfos,
  WarningInfos as WarningInfosSchema,
  type WarningLanguage,
  type WarningStatus,
} from '@kchs/contracts'
import { and, eq, getTableColumns, isNull } from 'drizzle-orm'
import { objects } from '~/kernel/objects/schema.js'
import { territoryIndex } from '~/modules/territories/public.js'
import type { Executor } from '~/shared/db/client.js'
import { errors } from '~/shared/errors.js'
import { type WarningRow, warnings } from '../schema.js'

/** Строка предупреждения с полями объекта реестра. */
export interface WarningEntry extends WarningRow {
  title: string
  spaceId: string | null
  createdBy: string | null
}

const selection = {
  ...getTableColumns(warnings),
  title: objects.title,
  spaceId: objects.spaceId,
  createdBy: objects.createdBy,
}

export const WarningStore = {
  async load(executor: Executor, id: string): Promise<WarningEntry | null> {
    const [row] = await executor
      .select(selection)
      .from(warnings)
      .innerJoin(objects, eq(objects.id, warnings.id))
      .where(and(eq(warnings.id, id), isNull(objects.deletedAt)))
      .limit(1)
    return row ?? null
  },

  async require(executor: Executor, id: string): Promise<WarningEntry> {
    const row = await WarningStore.load(executor, id)
    if (!row) throw errors.notFound('Предупреждение')
    return row
  },

  /** Та же строка под блокировкой: переходы статуса не идут наперегонки. */
  async lock(executor: Executor, id: string): Promise<WarningEntry> {
    const [locked] = await executor
      .select({ id: warnings.id })
      .from(warnings)
      .where(eq(warnings.id, id))
      .for('update')
    if (!locked) throw errors.notFound('Предупреждение')
    return WarningStore.require(executor, id)
  },
}

export const statusOf = (row: WarningRow) => row.status as WarningStatus
export const msgTypeOf = (row: WarningRow) => row.msgType as CapMsgType
export const capStatusOf = (row: WarningRow) => row.capStatus as CapStatus

/** Блоки `info` из базы: испорченное поле — пусто, а не ошибка чтения. */
export function infosOf(row: WarningRow): WarningInfos {
  const parsed = WarningInfosSchema.safeParse(row.info)
  return parsed.success ? parsed.data : {}
}

/** Блок языка, если в нём что-то написано. */
export function filledInfo(infos: WarningInfos, language: WarningLanguage): WarningInfo | null {
  const info = infos[language]
  if (!info) return null
  return info.headline || info.description || info.instruction || info.event ? info : null
}

/** Явление — из блока языка, иначе из первого заполненного (CAP требует `event` в каждом `info`). */
export function eventOf(infos: WarningInfos, language: WarningLanguage): string {
  const own = infos[language]?.event
  if (own) return own
  for (const other of ['ru', 'tg', 'en'] as const) {
    const value = infos[other]?.event
    if (value) return value
  }
  return ''
}

/** Название объекта: заголовок по-русски, по-таджикски, по-английски, иначе явление. */
export function titleOf(infos: WarningInfos): string {
  for (const language of ['ru', 'tg', 'en'] as const) {
    const headline = infos[language]?.headline
    if (headline) return headline
  }
  return eventOf(infos, 'ru') || 'Предупреждение'
}

/** Области из базы — в виде контракта. */
export function areasOf(row: WarningRow): WarningArea[] {
  return (row.areas ?? []).map((raw) => ({
    territoryId: typeof raw.territoryId === 'string' ? raw.territoryId : null,
    description: typeof raw.description === 'string' ? raw.description : '',
    polygon: Array.isArray(raw.polygon) ? (raw.polygon as Array<[number, number]>) : null,
  }))
}

/**
 * Области к записи: территория — из справочника, кольцо полигона замкнуто.
 * Неизвестная территория и полигон без площади — ошибка поля.
 */
export async function normalizeAreas(areas: readonly WarningArea[]): Promise<WarningArea[]> {
  const index = areas.some((area) => area.territoryId) ? await territoryIndex() : null
  return areas.map((area, position) => {
    if (area.territoryId && !index?.byId.has(area.territoryId)) {
      throw errors.validation('Территории нет в справочнике', [
        { path: `areas.${position}.territoryId`, message: 'Территории нет в справочнике' },
      ])
    }
    let polygon = area.polygon
    if (polygon) {
      const distinct = new Set(polygon.map(([lon, lat]) => `${lon},${lat}`))
      if (distinct.size < 3) {
        throw errors.validation('Полигон — не меньше трёх разных точек', [
          { path: `areas.${position}.polygon`, message: 'Полигон — не меньше трёх разных точек' },
        ])
      }
      const first = polygon[0] as [number, number]
      const last = polygon.at(-1) as [number, number]
      if (first[0] !== last[0] || first[1] !== last[1]) polygon = [...polygon, first]
    }
    return { territoryId: area.territoryId, description: area.description, polygon }
  })
}

/** Подписи областей: название территории по-русски или описание. */
export async function areaLabels(row: WarningRow): Promise<string[]> {
  const areas = areasOf(row)
  const index = areas.some((area) => area.territoryId) ? await territoryIndex() : null
  return areas.map((area) => {
    const territory = area.territoryId ? index?.byId.get(area.territoryId) : undefined
    return territory?.name.ru ?? area.description
  })
}

export const LANGUAGES: readonly WarningLanguage[] = WARNING_LANGUAGES
