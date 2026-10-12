import type { WarningLanguage } from '@kchs/contracts'
import { and, desc, eq, gt, isNull, or, sql } from 'drizzle-orm'
import { publishEvent } from '~/kernel/events/publisher.js'
import { ObjectService } from '~/kernel/objects/service.js'
import { TerritoryService, territoryIndex } from '~/modules/territories/public.js'
import { config } from '~/shared/config/index.js'
import { actorId, type Ctx, systemCtx } from '~/shared/context.js'
import { db, type Executor, type Tx } from '~/shared/db/client.js'
import { logger } from '~/shared/logger/index.js'
import { warnings } from '../schema.js'
import {
  type CapArea,
  type CapInfo,
  capDateTime,
  capPolygon,
  type FeedEntry,
  renderAtomFeed,
  renderCapAlert,
  renderRssFeed,
} from './cap.js'
import { CAP_LANGUAGE, capSender, capUrlOf, feedUrls, SENDER_NAMES } from './settings.js'
import {
  areaLabels,
  areasOf,
  capStatusOf,
  eventOf,
  filledInfo,
  infosOf,
  LANGUAGES,
  msgTypeOf,
  statusOf,
  titleOf,
  type WarningEntry,
  WarningStore,
} from './warning-store.js'

/** Зум упрощения границы территории для полигона CAP: ≈ 600 м — по району достаточно. */
const TERRITORY_ZOOM = 7

/** Код территории в `geocode`: регионы — ISO 3166-2, остальное — код справочника установки. */
function geocodeOf(code: string): { valueName: string; value: string } {
  return /^[A-Z]{2}-[A-Z0-9]{1,3}$/.test(code)
    ? { valueName: 'ISO 3166-2', value: code }
    : { valueName: 'KCHS-TERRITORY', value: code }
}

/** Внешние кольца границы территории — полигонами CAP; без границы — только код. */
async function territoryPolygons(territoryId: string): Promise<string[]> {
  try {
    const feature = await TerritoryService.feature(
      systemCtx('warnings.cap'),
      territoryId,
      TERRITORY_ZOOM,
    )
    const geometry = feature.geometry as { type: string; coordinates: unknown }
    const polygons =
      geometry.type === 'Polygon'
        ? [geometry.coordinates as number[][][]]
        : geometry.type === 'MultiPolygon'
          ? (geometry.coordinates as number[][][][])
          : []
    return polygons
      .map((rings) => capPolygon((rings[0] ?? []) as Array<[number, number]>))
      .filter((polygon): polygon is string => Boolean(polygon))
  } catch (error) {
    logger().debug({ err: error, territoryId }, 'граница территории для CAP недоступна')
    return []
  }
}

/** Области CAP на языке блока: название территории — на этом языке, иначе по-русски. */
async function capAreas(row: WarningEntry, language: WarningLanguage): Promise<CapArea[]> {
  const areas = areasOf(row)
  const index = areas.some((area) => area.territoryId) ? await territoryIndex() : null
  const result: CapArea[] = []
  for (const area of areas) {
    const territory = area.territoryId ? index?.byId.get(area.territoryId) : undefined
    const name = territory ? (territory.name[language] ?? territory.name.ru) : ''
    const areaDesc = [name, area.description].filter(Boolean).join('. ')
    const polygons = [
      ...(area.polygon ? [capPolygon(area.polygon)].filter((p): p is string => Boolean(p)) : []),
      ...(territory && !area.polygon ? await territoryPolygons(territory.id) : []),
    ]
    result.push({
      areaDesc,
      polygons,
      geocodes: territory ? [geocodeOf(territory.code)] : [],
    })
  }
  return result
}

/** `sender,identifier,sent` прежних сообщений цепочки — от первого к непосредственному. */
async function referencesOf(executor: Executor, row: WarningEntry): Promise<string | null> {
  const chain: string[] = []
  let currentId = row.referencesId
  const seen = new Set<string>()
  while (currentId && !seen.has(currentId) && chain.length < 50) {
    seen.add(currentId)
    const [previous] = await executor
      .select({
        identifier: warnings.identifier,
        publishedAt: warnings.publishedAt,
        referencesId: warnings.referencesId,
      })
      .from(warnings)
      .where(eq(warnings.id, currentId))
      .limit(1)
    if (!previous?.publishedAt) break
    chain.unshift(
      `${capSender()},${previous.identifier},${capDateTime(previous.publishedAt, config().TZ)}`,
    )
    currentId = previous.referencesId
  }
  return chain.length > 0 ? chain.join(' ') : null
}

/** Документ CAP 1.2 опубликованного предупреждения: снимок на момент выпуска. */
export async function buildCap(executor: Executor, row: WarningEntry, sent: Date): Promise<string> {
  const timeZone = config().TZ
  const infos = infosOf(row)
  const blocks: CapInfo[] = []
  for (const language of LANGUAGES) {
    const info = filledInfo(infos, language)
    if (!info) continue
    blocks.push({
      language: CAP_LANGUAGE[language],
      categories: row.categories,
      event: eventOf(infos, language),
      responseTypes: row.responseTypes,
      urgency: row.urgency,
      severity: row.severity,
      certainty: row.certainty,
      effective: row.effective ? capDateTime(row.effective, timeZone) : null,
      expires: row.expires ? capDateTime(row.expires, timeZone) : null,
      senderName: SENDER_NAMES[language],
      headline: info.headline,
      description: info.description,
      instruction: info.instruction,
      web: null,
      areas: await capAreas(row, language),
    })
  }
  return renderCapAlert({
    identifier: row.identifier,
    sender: capSender(),
    sent: capDateTime(sent, timeZone),
    status: capStatusOf(row),
    msgType: msgTypeOf(row),
    references: await referencesOf(executor, row),
    infos: blocks,
  })
}

async function setStatus(
  tx: Tx,
  ctx: Ctx,
  id: string,
  status: string,
  patch: Partial<typeof warnings.$inferInsert> = {},
): Promise<void> {
  await tx
    .update(warnings)
    .set({ ...patch, status, updatedAt: sql`now()` })
    .where(eq(warnings.id, id))
  await ObjectService.update(tx, ctx, id, { meta: { status }, mergeMeta: true }, { silent: true })
}

const objectOf = (row: WarningEntry) => ({
  id: row.id,
  type: 'warning' as const,
  spaceId: row.spaceId,
  title: row.title,
})

export const WarningPublication = {
  /** Маршрут выпуска начался (из карточки или общим API): черновик — «на утверждении». */
  async onApproval(tx: Tx, ctx: Ctx, id: string, processId: string): Promise<void> {
    const row = await WarningStore.lock(tx, id)
    if (statusOf(row) !== 'draft') return
    await setStatus(tx, ctx, id, 'on_approval')
    await publishEvent(tx, ctx, {
      type: 'warning.submitted',
      object: objectOf(row),
      payload: { processId },
    })
  },

  /** Маршрут кончился без решения о выпуске — снова черновик. */
  async returnToDraft(tx: Tx, ctx: Ctx, id: string, outcome: string): Promise<void> {
    const row = await WarningStore.lock(tx, id)
    if (statusOf(row) !== 'on_approval') return
    await setStatus(tx, ctx, id, 'draft')
    await publishEvent(tx, ctx, {
      type: 'warning.returned',
      object: objectOf(row),
      payload: { outcome },
    })
  },

  /**
   * Решение уполномоченного лица принято (ADR-0202): «утверждено» и сразу
   * «опубликовано» в той же транзакции — снимок CAP, `warning.published` в outbox;
   * прежнее предупреждение цепочки — «уточнено» или «отменено». Сбой сборки CAP
   * откатывает и подпись: решение без публикации не остаётся.
   */
  async publish(tx: Tx, ctx: Ctx, id: string): Promise<void> {
    const row = await WarningStore.lock(tx, id)
    const status = statusOf(row)
    if (status !== 'on_approval' && status !== 'approved') return
    const approver = actorId(ctx)
    const sent = new Date(Math.floor(Date.now() / 1000) * 1000)
    if (status === 'on_approval') {
      await setStatus(tx, ctx, id, 'approved', {
        approvedAt: sent.toISOString(),
        approvedById: approver,
      })
    }
    const capXml = await buildCap(tx, row, sent)
    await setStatus(tx, ctx, id, 'published', { publishedAt: sent.toISOString(), capXml })

    const infos = infosOf(row)
    let referencesIdentifier: string | null = null
    if (row.referencesId) {
      const previous = await WarningStore.lock(tx, row.referencesId)
      referencesIdentifier = previous.identifier
      if (statusOf(previous) === 'published') {
        const next = msgTypeOf(row) === 'Cancel' ? 'cancelled' : 'updated'
        await setStatus(tx, ctx, previous.id, next, { supersededById: id })
        await publishEvent(tx, ctx, {
          type: 'warning.superseded',
          object: objectOf(previous),
          payload: { by: id, status: next },
        })
      }
    }
    await publishEvent(tx, ctx, {
      type: 'warning.published',
      object: objectOf(row),
      payload: {
        identifier: row.identifier,
        msgType: msgTypeOf(row),
        capStatus: capStatusOf(row),
        sent: sent.toISOString(),
        references: row.referencesId,
        referencesIdentifier,
        event: eventOf(infos, 'ru'),
        headline: titleOf(infos),
        urgency: row.urgency,
        severity: row.severity,
        certainty: row.certainty,
        effective: row.effective ? new Date(row.effective).toISOString() : null,
        expires: row.expires ? new Date(row.expires).toISOString() : null,
        areas: await areaLabels(row),
        capUrl: capUrlOf(id),
        sourceDatasetId: row.sourceDatasetId,
        sourceRowId: row.sourceRowId,
      },
    })
  },
}

/** Опубликованный CAP по идентификатору: снимок выпуска (и уточнённых, и отменённых). */
export async function publishedCap(id: string): Promise<{ xml: string; sent: Date } | null> {
  const [row] = await db()
    .select({ xml: warnings.capXml, publishedAt: warnings.publishedAt })
    .from(warnings)
    .where(eq(warnings.id, id))
    .limit(1)
  if (!row?.xml || !row.publishedAt) return null
  return { xml: row.xml, sent: new Date(row.publishedAt) }
}

/** Действующие опубликованные: срок не истёк. Отмены и уточнения — тоже записи ленты. */
async function activeEntries(language: WarningLanguage): Promise<FeedEntry[]> {
  const rows = await db()
    .select({
      id: warnings.id,
      identifier: warnings.identifier,
      info: warnings.info,
      publishedAt: warnings.publishedAt,
    })
    .from(warnings)
    .where(
      and(
        eq(warnings.status, 'published'),
        or(isNull(warnings.expires), gt(warnings.expires, sql`now()`)),
      ),
    )
    .orderBy(desc(warnings.publishedAt))
    .limit(200)
  return rows.map((row) => {
    const infos = infosOf(row as never)
    const info = filledInfo(infos, language) ?? filledInfo(infos, 'ru') ?? filledInfo(infos, 'tg')
    return {
      identifier: row.identifier,
      title: info?.headline || eventOf(infos, language) || titleOf(infos),
      summary: info?.description ?? '',
      sent: new Date(row.publishedAt as string),
      capUrl: capUrlOf(row.id),
    }
  })
}

const FEED_TITLES: Record<WarningLanguage, string> = {
  tg: 'Огоҳиҳои КҲФ ва МГ',
  ru: 'Предупреждения КЧС и ГО',
  en: 'CESCD warnings',
}

/** Индекс Atom опубликованных — по-русски, ссылки ведут на CAP со всеми языками. */
export async function atomFeed(): Promise<string> {
  const entries = await activeEntries('ru')
  const urls = feedUrls()
  return renderAtomFeed({
    id: urls.atom,
    title: FEED_TITLES.ru,
    selfUrl: urls.atom,
    updated: entries[0]?.sent ?? new Date(0),
    author: SENDER_NAMES.ru,
    language: 'ru',
    entries,
  })
}

/** RSS одного языка: заголовок и описание — из блока этого языка. */
export async function rssFeed(language: WarningLanguage): Promise<string> {
  const urls = feedUrls()
  return renderRssFeed({
    title: FEED_TITLES[language],
    link: urls.rss[language],
    description: SENDER_NAMES[language],
    language: CAP_LANGUAGE[language].toLowerCase(),
    entries: await activeEntries(language),
  })
}
