import {
  type Bbox,
  type GeocodeMatch,
  type GeocodeResult,
  type ReverseGeocodeResponse,
  TERRITORY_LEVELS,
  type Territory,
} from '@kchs/contracts'
import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import { search } from '~/kernel/search/index-service.js'
import type { UserCtx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { objects, territories } from '~/shared/db/schema/index.js'
import { logger } from '~/shared/logger/index.js'
import { normalizeName, type TerritoryIndex, territoryIndex } from './territory-index.js'

/** Ближайший населённый пункт при обратном геокодировании — не дальше, м. */
const NEAREST_SETTLEMENT_M = 10_000

const LEVEL_RANK = new Map(TERRITORY_LEVELS.map((level, index) => [level, index]))
const MATCH_RANK: Record<GeocodeMatch, number> = {
  code: 0,
  name: 1,
  prefix: 2,
  word: 3,
  substring: 4,
  fuzzy: 5,
}
// Таджикские буквы — как русские: «Кулоб» находит «Кӯлоб», «Хучанд» — «Хуҷанд»
const TAJIK: Record<string, string> = { ӣ: 'и', ӯ: 'у', ҳ: 'х', ҷ: 'ч', қ: 'к', ғ: 'г' }

/** Ключ поиска по названию: `normalizeName`, таджикские буквы, без кавычек и дефисов. */
export function searchKey(value: string): string {
  return normalizeName(value)
    .replace(/[ӣӯҳҷқғ]/g, (char) => TAJIK[char] ?? char)
    .replace(/[«»"'`’ʼ]/g, '')
    .replace(/[-‐–—]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

interface Entry {
  territory: Territory
  code: string
  names: string[]
  words: string[]
}

/** Ключи поиска справочника — на версию индекса территорий. */
const entriesCache = new WeakMap<TerritoryIndex, Map<string, Entry>>()

function entriesOf(index: TerritoryIndex): Map<string, Entry> {
  let entries = entriesCache.get(index)
  if (!entries) {
    entries = new Map()
    for (const territory of index.items) {
      const names = [
        ...new Set(
          [territory.name.ru, territory.name.tg, territory.name.en]
            .filter((name): name is string => Boolean(name))
            .map(searchKey),
        ),
      ]
      entries.set(territory.id, {
        territory,
        code: territory.code.toLowerCase(),
        names,
        words: names.flatMap((name) => name.split(' ')),
      })
    }
    entriesCache.set(index, entries)
  }
  return entries
}

function matchOf(entry: Entry, key: string, code: string): GeocodeMatch | null {
  if (entry.code === code) return 'code'
  if (entry.names.includes(key)) return 'name'
  // Начало кода: «TJ-KT-07-» — населённые пункты района
  if (code.length >= 3 && code.includes('-') && entry.code.startsWith(code)) return 'code'
  if (!key) return null
  if (entry.names.some((name) => name.startsWith(key))) return 'prefix'
  if (entry.words.some((word) => word.startsWith(key))) return 'word'
  if (key.length >= 3 && entry.names.some((name) => name.includes(key))) return 'substring'
  return null
}

/** Уточнение через запятую («Навобод, Вахш») — начало названия или код одного из предков. */
function withinContext(index: TerritoryIndex, territory: Territory, context: string[]): boolean {
  const entries = entriesOf(index)
  const ancestors = index.ancestors(territory.id)
  return context.every((part) => {
    const key = searchKey(part)
    const code = part.toLowerCase().replace(/\s+/g, '')
    return ancestors.some((ancestor) => {
      const entry = entries.get(ancestor.id)
      return entry ? matchOf(entry, key, code) !== null : false
    })
  })
}

async function bboxes(ids: string[]): Promise<Map<string, Bbox>> {
  if (ids.length === 0) return new Map()
  const rows = await db()
    .select({
      id: territories.id,
      bbox: sql<Bbox>`json_build_array(ST_XMin(${territories.geom}), ST_YMin(${territories.geom}),
        ST_XMax(${territories.geom}), ST_YMax(${territories.geom}))`,
    })
    .from(territories)
    .where(and(inArray(territories.id, ids), isNotNull(territories.geom)))
  return new Map(rows.map((row) => [row.id, row.bbox]))
}

/** Опечатки — через поисковый индекс ядра; он недоступен — результатов просто меньше. */
async function fuzzyIds(ctx: UserCtx, q: string, limit: number): Promise<string[]> {
  try {
    const result = await search(ctx, { q, types: ['territory'], limit, offset: 0 })
    return result.hits.map((hit) => hit.objectId)
  } catch (error) {
    logger().debug({ err: error }, 'геокодер: поисковый индекс недоступен')
    return []
  }
}

/**
 * Внутренний геокодер (07-gis-engine.md §9, ADR-0067): справочник территорий в памяти
 * процесса — названия на всех языках и коды; опечатки добирает поисковый индекс.
 */
export const Geocoder = {
  async search(ctx: UserCtx, q: string, limit: number): Promise<GeocodeResult[]> {
    const index = await territoryIndex()
    const [main = '', ...context] = q.split(',').map((part) => part.trim())
    const key = searchKey(main)
    const code = main.toLowerCase().replace(/\s+/g, '')
    const found = new Map<string, GeocodeMatch>()
    for (const entry of entriesOf(index).values()) {
      const match = matchOf(entry, key, code)
      if (match) found.set(entry.territory.id, match)
    }
    const filtered = (ids: string[]) =>
      ids.filter((id) => {
        const territory = index.byId.get(id)
        return territory?.centroid && withinContext(index, territory, context.filter(Boolean))
      })
    let ranked = filtered([...found.keys()]).sort((a, b) => compare(index, found, a, b))
    if (ranked.length < limit && key.length >= 3) {
      for (const id of filtered(await fuzzyIds(ctx, main, limit))) {
        if (!found.has(id)) {
          found.set(id, 'fuzzy')
          ranked.push(id)
        }
      }
    }
    ranked = ranked.slice(0, limit)
    const extents = await bboxes(ranked)
    return ranked.map((id) => {
      const territory = index.byId.get(id) as Territory
      return {
        territory,
        path: index.ancestors(id),
        center: territory.centroid as { lon: number; lat: number },
        bbox: extents.get(id) ?? null,
        match: found.get(id) as GeocodeMatch,
      }
    })
  },

  /**
   * Обратное геокодирование: единицы с границей, покрывающие точку (по одной на уровень),
   * и ближайший населённый пункт в пределах 10 км.
   */
  async reverse(lon: number, lat: number): Promise<ReverseGeocodeResponse> {
    const index = await territoryIndex()
    const point = sql`ST_SetSRID(ST_MakePoint(${lon}, ${lat}), 4326)`
    const containing = await db()
      .select({ id: territories.id })
      .from(territories)
      .innerJoin(objects, eq(objects.id, territories.id))
      .where(
        and(
          isNull(objects.deletedAt),
          isNotNull(territories.geom),
          sql`ST_Covers(${territories.geom}, ${point})`,
        ),
      )
    const chain: Territory[] = []
    const levels = new Set<string>()
    for (const territory of containing
      .map((row) => index.byId.get(row.id))
      .filter((item): item is Territory => Boolean(item))
      .sort(
        (a, b) =>
          (LEVEL_RANK.get(a.level) ?? 0) - (LEVEL_RANK.get(b.level) ?? 0) ||
          a.code.localeCompare(b.code),
      )) {
      // Точка на общей границе соседей — берём одного
      if (levels.has(territory.level)) continue
      levels.add(territory.level)
      chain.push(territory)
    }

    const distance = sql<number>`ST_Distance(${territories.centroid}::geography, ${point}::geography)`
    const [nearest] = await db()
      .select({ id: territories.id, distance })
      .from(territories)
      .innerJoin(objects, eq(objects.id, territories.id))
      .where(
        and(
          isNull(objects.deletedAt),
          eq(territories.level, 'settlement'),
          isNotNull(territories.centroid),
          sql`ST_DWithin(${territories.centroid}::geography, ${point}::geography, ${NEAREST_SETTLEMENT_M})`,
        ),
      )
      .orderBy(distance)
      .limit(1)
    const settlement = nearest ? index.byId.get(nearest.id) : undefined
    return {
      chain,
      nearest:
        settlement && nearest ? { territory: settlement, distanceM: nearest.distance } : null,
    }
  },
}

function compare(
  index: TerritoryIndex,
  found: Map<string, GeocodeMatch>,
  a: string,
  b: string,
): number {
  const left = index.byId.get(a) as Territory
  const right = index.byId.get(b) as Territory
  return (
    MATCH_RANK[found.get(a) as GeocodeMatch] - MATCH_RANK[found.get(b) as GeocodeMatch] ||
    (LEVEL_RANK.get(left.level) ?? 0) - (LEVEL_RANK.get(right.level) ?? 0) ||
    left.name.ru.length - right.name.ru.length ||
    left.code.localeCompare(right.code)
  )
}
