import {
  FEED_MAX_BYTES,
  FEED_TIMEOUT_MS,
  type FeedConfig,
  type FeedFormat,
  type FeedPreview,
  type FeedPreviewInput,
  type FeedSourceCreateInput,
  type SourceRunResult,
  type StoredFieldType,
} from '@kchs/contracts'
import { fieldSchema } from '@kchs/fields'
import { UnrecoverableError } from 'bullmq'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { authorize } from '~/kernel/access/authorize.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import { LinkService } from '~/kernel/links/service.js'
import { ObjectService } from '~/kernel/objects/service.js'
import { type LocatableGeometry, TerritoryLocator, territoryIndex } from '~/modules/gis/public.js'
import { HttpIntegration, hasSecretRef, Integrations } from '~/modules/integrations/public.js'
import type { Ctx, UserCtx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import { datasets, dependencies, sourceRuns, sources } from '~/shared/db/schema/index.js'
import { AppError, errors } from '~/shared/errors.js'
import { type OutboundOptions, outboundGet } from '~/shared/net/outbound.js'
import { ident, qualified } from '../infra/physical.js'
import { DatasetService, type DatasetStorage, type StoredField } from './dataset-service.js'
import {
  discoverPaths,
  type FeedRecord,
  flattenRecord,
  keyText,
  mappedValue,
  parseFeed,
  recordGeometry,
  withinBbox,
} from './feed-parse.js'
import { RowService, selectList, valuesOf } from './row-service.js'
import { assertCron, type SourceObjectRow, sourceEventObject } from './source-shared.js'

/**
 * Лента по адресу (ADR-0132): источник вида `feed`. Сервер по расписанию
 * забирает GeoJSON, CSV или JSON, отбирает записи по области и границам
 * территорий, раскладывает поля записи по полям датасета и пишет строки через
 * `RowService` — с историей строк, версией и событиями, как ручная правка.
 * Новые записи вставляются; у записей с тем же ключом обновляются только поля
 * ленты и только если значения изменились: статус и решение дежурного лента не
 * трогает. Строку, которую удалили вручную, лента заново не заводит.
 */

const WHAT = 'лента по адресу'
/** Столько ключей ищем в датасете одним запросом. */
const LOOKUP_CHUNK = 500
/** Столько причин пропуска записей сохраняет прогон. */
const MAX_REASONS = 5

const ACCEPT: Record<FeedFormat, string> = {
  geojson: 'application/geo+json, application/json;q=0.9, */*;q=0.1',
  json: 'application/json, */*;q=0.1',
  csv: 'text/csv, text/plain;q=0.9, */*;q=0.1',
}

/** Поле датасета для проверки настройки ленты. */
interface FieldInfo {
  key: string
  type: string
  required: boolean
  readOnly: boolean
  hasDefault: boolean
  label: string
}

const infoOf = (field: {
  key: string
  type: string
  required?: boolean | undefined
  readOnly?: boolean | undefined
  default?: unknown
  label: { ru: string }
}): FieldInfo => ({
  key: field.key,
  type: field.type,
  required: field.required ?? false,
  readOnly: field.readOnly ?? false,
  hasDefault: field.default !== undefined && field.default !== null,
  label: field.label.ru,
})

/**
 * Настройка ленты против полей датасета-приёмника: поля есть и правятся, ключ —
 * из полей ленты, геометрия и территория — поля своего типа, обязательные поля
 * заполняет лента или значение по умолчанию. Пустой список — настройка годится.
 */
export function feedIssues(fields: readonly FieldInfo[], feed: FeedConfig): string[] {
  const issues: string[] = []
  const byKey = new Map(fields.map((field) => [field.key, field]))
  const mapped = new Set<string>()
  for (const item of feed.mapping) {
    const field = byKey.get(item.field)
    if (!field) {
      issues.push(`Поля «${item.field}» нет в датасете`)
      continue
    }
    if (mapped.has(item.field)) issues.push(`Поле «${field.label}» сопоставлено дважды`)
    if (field.readOnly) issues.push(`Поле «${field.label}» только для чтения`)
    mapped.add(item.field)
  }
  const special = [
    { key: feed.geometryField, type: 'geometry', what: 'геометрии' },
    { key: feed.territoryField, type: 'territory', what: 'территории' },
  ]
  for (const item of special) {
    if (!item.key) continue
    const field = byKey.get(item.key)
    if (!field) issues.push(`Поля «${item.key}» нет в датасете`)
    else if (field.type !== item.type) issues.push(`Поле «${field.label}» — не поле ${item.what}`)
    if (mapped.has(item.key)) issues.push(`Поле «${item.key}» заполняет и сопоставление, и лента`)
  }
  const needsGeometry =
    feed.geometryField || feed.territoryField || feed.withinTerritory || feed.bbox !== null
  if (needsGeometry && !feed.geometry) {
    issues.push('Для области, территорий и поля геометрии укажите, откуда брать геометрию записи')
  }
  for (const key of feed.keyFields) {
    if (!mapped.has(key)) issues.push(`Ключевое поле «${key}» должна заполнять лента`)
  }
  if (new Set(feed.keyFields).size !== feed.keyFields.length) {
    issues.push('Поля ключа повторяются')
  }
  const filled = new Set([...mapped, feed.geometryField, feed.territoryField])
  for (const field of fields) {
    if (field.required && !field.hasDefault && !filled.has(field.key)) {
      issues.push(
        `Обязательное поле «${field.label}» лента не заполняет и значения по умолчанию у него нет`,
      )
    }
  }
  return issues
}

function assertFeed(fields: readonly FieldInfo[], feed: FeedConfig): void {
  const issues = feedIssues(fields, feed)
  if (issues.length > 0) {
    throw new AppError('validation_failed', issues[0] as string, 400, {
      fieldErrors: issues.map((message) => ({ path: 'feed', message })),
    })
  }
}

/** Ссылки на секреты без интеграции: сервер не знает, чем их заменить. */
function assertSecrets(
  target: { url: string; headers: Record<string, string> },
  integrationId: string | null,
) {
  if (integrationId) return
  if ([target.url, ...Object.values(target.headers)].some(hasSecretRef)) {
    throw errors.validation(
      'Адрес или заголовок ссылается на секрет — выберите интеграцию HTTP с ним',
    )
  }
}

/** Ответ ленты: с секретами интеграции или напрямую; код не 200 — ошибка с кодом. */
async function fetchFeed(
  target: { url: string; headers: Record<string, string>; format: FeedFormat },
  integrationId: string | null,
): Promise<Buffer> {
  assertSecrets(target, integrationId)
  const options: Omit<OutboundOptions, 'headers'> = {
    what: WHAT,
    accept: ACCEPT[target.format],
    maxBytes: FEED_MAX_BYTES,
    timeoutMs: FEED_TIMEOUT_MS,
    maxRedirects: 3,
  }
  const response = integrationId
    ? await HttpIntegration.get(
        integrationId,
        { url: target.url, headers: target.headers },
        options,
      )
    : await outboundGet(target.url, { ...options, headers: target.headers })
  if (response.status !== 200) {
    throw errors.dependencyFailed(`Лента ответила кодом ${response.status}`, {
      status: response.status,
    })
  }
  return response.body
}

/** Настройка ленты из записи источника. */
export function feedOf(row: { config: Record<string, unknown> }): FeedConfig {
  return (row.config as { feed: FeedConfig }).feed
}

/** Одинаковы ли значение ленты и значение строки — по типу поля, без ложных «изменений». */
function sameValue(type: string, next: unknown, current: unknown): boolean {
  if (next === null || next === undefined) return current === null || current === undefined
  if (current === null || current === undefined) return false
  if (type === 'datetime') return Date.parse(String(next)) === Date.parse(String(current))
  if (type === 'date') return String(next).slice(0, 10) === String(current).slice(0, 10)
  if (['integer', 'number', 'decimal', 'money', 'percent'].includes(type)) {
    return Number(next) === Number(current)
  }
  if (type === 'boolean') return Boolean(next) === Boolean(current)
  if (type === 'geometry') return rounded(next) === rounded(current)
  if (type === 'multi_select' && Array.isArray(next) && Array.isArray(current)) {
    return JSON.stringify([...next].sort()) === JSON.stringify([...current].sort())
  }
  if (type === 'json') return JSON.stringify(next) === JSON.stringify(current)
  return String(next) === String(current)
}

/** Геометрия с координатами до 7 знаков: хранение округляет последние разряды. */
function rounded(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'number' ? Math.round(item * 1e7) / 1e7 : item,
  )
}

interface PreparedRecord {
  key: string[]
  values: Record<string, unknown>
}

interface Prepared {
  records: PreparedRecord[]
  read: number
  skipped: number
  reasons: string[]
}

/**
 * Записи ленты → значения строк: область, геометрия, район, сопоставление,
 * проверка значений по полям датасета, ключ; повтор ключа в одном ответе —
 * последняя запись.
 */
async function prepare(
  storage: DatasetStorage,
  feed: FeedConfig,
  records: FeedRecord[],
): Promise<Prepared> {
  const byKey = new Map(storage.fields.map((field) => [field.key, field]))
  const reasons: string[] = []
  let skipped = 0
  const skip = (reason: string) => {
    skipped += 1
    if (reasons.length < MAX_REASONS && !reasons.includes(reason)) reasons.push(reason)
  }

  // Геометрия и область — до сопоставления: чужие записи дальше не разбираются
  const located: Array<{ record: FeedRecord; geometry: LocatableGeometry | null }> = []
  for (const record of records) {
    const geometry = recordGeometry(record, feed.geometry)
    if (feed.bbox && !(geometry && withinBbox(geometry, feed.bbox))) continue
    located.push({ record, geometry })
  }
  if (located.length > feed.maxItems) {
    throw errors.dependencyFailed(
      `Лента отдала ${located.length} записей, предел — ${feed.maxItems}: сузьте область или адрес`,
    )
  }
  const districts =
    feed.territoryField || feed.withinTerritory
      ? await TerritoryLocator.locate(located.map((item) => item.geometry))
      : located.map(() => null)
  const territories = storage.fields.some((field) => field.type === 'territory')
    ? await territoryIndex()
    : null

  const byRecordKey = new Map<string, PreparedRecord>()
  located.forEach(({ record, geometry }, index) => {
    const district = districts[index] ?? null
    if (feed.withinTerritory && !district) return
    const values: Record<string, unknown> = {}
    for (const item of feed.mapping) {
      const field = byKey.get(item.field)
      if (!field) continue
      let value = mappedValue(record, item.value, field.type as StoredFieldType)
      // Территория из ленты кодом или названием — в идентификатор справочника
      if (field.type === 'territory' && typeof value === 'string' && territories) {
        const found = territories.byId.has(value) ? value : territories.resolve(value)
        value = found && found !== 'ambiguous' ? found : value
      }
      values[item.field] = value
    }
    if (feed.geometryField) values[feed.geometryField] = geometry
    if (feed.territoryField) values[feed.territoryField] = district
    for (const [key, value] of Object.entries(values)) {
      const field = byKey.get(key) as StoredField
      const parsed = fieldSchema(field, false).safeParse(value)
      if (!parsed.success) {
        skip(`«${field.label.ru}»: ${parsed.error.issues[0]?.message ?? 'некорректное значение'}`)
        return
      }
      values[key] = parsed.data ?? null
    }
    const key = feed.keyFields.map((field) => keyText(values[field]))
    if (key.some((part) => part === null)) {
      skip('у записи нет значения ключа')
      return
    }
    byRecordKey.set(JSON.stringify(key), { key: key as string[], values })
  })
  return { records: [...byRecordKey.values()], read: records.length, skipped, reasons }
}

interface ExistingRow {
  id: string
  ver: number
  deleted: boolean
  values: Record<string, unknown>
}

/** Строки датасета с ключами ленты — и удалённые: их лента не заводит заново. */
async function existingRows(
  tx: Executor,
  storage: DatasetStorage,
  feed: FeedConfig,
  keys: string[][],
  fields: StoredField[],
): Promise<Map<string, ExistingRow>> {
  const found = new Map<string, ExistingRow>()
  if (keys.length === 0) return found
  const byKey = new Map(storage.fields.map((field) => [field.key, field]))
  const keyFields = feed.keyFields.map((key) => byKey.get(key) as StoredField)
  const table = sql.raw(qualified(storage.table))
  const keyColumns = keyFields.map((field) => sql`${sql.raw(ident(field.physical))}::text`)
  const keyList = sql.join(
    keyFields.map(
      (field, index) => sql`${sql.raw(ident(field.physical))}::text AS ${sql.raw(`"_k${index}"`)}`,
    ),
    sql`, `,
  )
  for (let start = 0; start < keys.length; start += LOOKUP_CHUNK) {
    const chunk = keys.slice(start, start + LOOKUP_CHUNK)
    const tuples = sql.join(
      chunk.map(
        (key) =>
          sql`(${sql.join(
            key.map((part) => sql`${part}`),
            sql`, `,
          )})`,
      ),
      sql`, `,
    )
    const rows = await tx.execute<Record<string, unknown>>(
      sql`SELECT _id::text AS _id, _ver, _deleted_at IS NOT NULL AS _deleted, ${keyList}
                 ${selectList(fields)}
            FROM ${table}
           WHERE (${sql.join(keyColumns, sql`, `)}) IN (${tuples})`,
    )
    for (const row of rows) {
      const key = keyFields.map((_field, index) => String(row[`_k${index}`]))
      found.set(JSON.stringify(key), {
        id: String(row._id),
        ver: Number(row._ver),
        deleted: Boolean(row._deleted),
        values: valuesOf(row, fields),
      })
    }
  }
  return found
}

export const FeedService = {
  async create(ctx: UserCtx, input: FeedSourceCreateInput): Promise<string> {
    assertCron(input.schedule)
    assertSecrets(input.feed, input.integrationId)
    if (input.integrationId) {
      await authorize(ctx, 'view', input.integrationId)
      await HttpIntegration.assertUsable(input.integrationId)
    }
    if (input.target.kind === 'existing') {
      // Лента пишет строки: право правки датасета — у того, кто её заводит
      await authorize(ctx, 'edit', input.target.datasetId)
      const storage = await DatasetService.storage(input.target.datasetId)
      if (!storage.settings.editable) {
        throw errors.validation('Правка строк датасета отключена — лента писать в него не сможет')
      }
      assertFeed(storage.fields.map(infoOf), input.feed)
    } else {
      assertFeed(input.target.fields.map(infoOf), input.feed)
    }

    return db().transaction(async (tx) => {
      const datasetId =
        input.target.kind === 'existing'
          ? input.target.datasetId
          : await DatasetService.create(tx, ctx, {
              name: input.target.name,
              description: `Записи ленты «${input.name}»`,
              spaceId: input.spaceId,
              parentId: input.parentId ?? null,
              kind: 'table',
              fields: input.target.fields,
              primaryKey: input.feed.keyFields,
              settings: { editable: true, trackHistory: true },
            })
      const object = await ObjectService.create(tx, ctx, {
        type: 'source',
        spaceId: input.spaceId,
        parentId: input.parentId ?? null,
        title: input.name,
        subtitle: input.description ?? null,
        meta: { mode: 'incremental', kind: 'feed' },
      })
      await tx.insert(sources).values({
        id: object.id,
        kind: 'feed',
        integrationId: input.integrationId,
        config: { feed: input.feed } as unknown as Record<string, unknown>,
        description: input.description ?? null,
        mode: 'incremental',
        datasetId,
        schedule: input.schedule ?? null,
        enabled: input.enabled,
        status: 'draft',
      })
      // «Откуда данные» — первая лента датасета; следующие видны связями
      await tx
        .update(datasets)
        .set({ sourceId: object.id })
        .where(and(eq(datasets.id, datasetId), isNull(datasets.sourceId)))
      if (input.integrationId) {
        await LinkService.setDependencies(tx, object.id, [input.integrationId], 'uses')
      }
      // Происхождение (ADR-0102): у общего датасета нескольких лент — все они
      const derived = await tx
        .select({ toId: dependencies.toId })
        .from(dependencies)
        .where(and(eq(dependencies.fromId, datasetId), eq(dependencies.kind, 'derives_from')))
      await LinkService.setDependencies(
        tx,
        datasetId,
        [...derived.map((row) => row.toId), object.id],
        'derives_from',
      )
      await LinkService.link(tx, ctx, datasetId, object.id, 'source')
      await publishEvent(tx, ctx, {
        type: 'source.created',
        object: sourceEventObject(object.id, {
          title: input.name,
          spaceId: object.spaceId,
          parentId: input.parentId ?? null,
        }),
        payload: { kind: 'feed', integrationId: input.integrationId, mode: 'incremental' },
      })
      return object.id
    })
  },

  /** Новая настройка ленты или интеграция: проверка против полей датасета. */
  async validateUpdate(
    ctx: UserCtx,
    row: {
      datasetId: string | null
      integrationId: string | null
      config: Record<string, unknown>
    },
    input: { feed?: FeedConfig | undefined; integrationId?: string | null | undefined },
  ): Promise<{ feed: FeedConfig; integrationId: string | null }> {
    const feed = input.feed ?? feedOf(row)
    const integrationId =
      input.integrationId === undefined ? row.integrationId : input.integrationId
    if (input.integrationId) {
      await authorize(ctx, 'view', input.integrationId)
      await HttpIntegration.assertUsable(input.integrationId)
    }
    assertSecrets(feed, integrationId)
    if (row.datasetId) {
      const storage = await DatasetService.storage(row.datasetId)
      assertFeed(storage.fields.map(infoOf), feed)
    }
    return { feed, integrationId }
  },

  /** Предпросмотр ленты по адресу: записи и найденные пути — без сохранения. */
  async preview(ctx: UserCtx, input: FeedPreviewInput): Promise<FeedPreview> {
    if (input.integrationId) await authorize(ctx, 'view', input.integrationId)
    const body = await fetchFeed(input, input.integrationId)
    const records = parseFeed(body, input.format, input.itemsPath)
    return {
      total: records.length,
      items: records.slice(0, input.limit).map((record) => flattenRecord(record)),
      paths: discoverPaths(records.slice(0, 200)),
    }
  },

  /** Проверка ленты: адрес отвечает и разбирается. */
  async check(row: { config: Record<string, unknown>; integrationId: string | null }) {
    const feed = feedOf(row)
    try {
      const body = await fetchFeed(feed, row.integrationId)
      const records = parseFeed(body, feed.format, feed.itemsPath)
      return { ok: true, message: `Лента читается, записей в ответе: ${records.length}` }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Лента не читается' }
    }
  },

  /**
   * Опрос ленты (задание `data:source.sync`): запрос, разбор, отбор и запись
   * строк одной транзакцией вместе с журналом прогона и событием `source.synced`.
   */
  async execute(
    ctx: Ctx,
    source: { row: typeof sources.$inferSelect; object: SourceObjectRow },
    run: { jobId: string; runId: string },
  ): Promise<SourceRunResult> {
    const { row, object } = source
    if (!row.datasetId) throw new UnrecoverableError('У ленты нет датасета-приёмника')
    const feed = feedOf(row)
    const storage = await DatasetService.storage(row.datasetId)

    await db().transaction(async (tx) => {
      await tx
        .update(sources)
        .set({ status: 'running', jobId: run.jobId, updatedAt: sql`now()` })
        .where(eq(sources.id, row.id))
      await tx.update(sourceRuns).set({ status: 'running' }).where(eq(sourceRuns.id, run.runId))
    })

    try {
      const body = await fetchFeed(feed, row.integrationId)
      const prepared = await prepare(storage, feed, parseFeed(body, feed.format, feed.itemsPath))
      const byKey = new Map(storage.fields.map((field) => [field.key, field]))
      const written = [
        ...feed.mapping.map((item) => item.field),
        ...(feed.geometryField ? [feed.geometryField] : []),
        ...(feed.territoryField ? [feed.territoryField] : []),
      ].map((key) => byKey.get(key) as StoredField)

      const outcome = await db().transaction(async (tx) => {
        const existing = await existingRows(
          tx,
          storage,
          feed,
          prepared.records.map((record) => record.key),
          written,
        )
        const inserts: Array<{ values: Record<string, unknown> }> = []
        const updates: Array<{ row: ExistingRow; values: Record<string, unknown> }> = []
        let unchanged = 0
        let deleted = 0
        for (const record of prepared.records) {
          const current = existing.get(JSON.stringify(record.key))
          if (!current) {
            inserts.push({ values: record.values })
            continue
          }
          if (current.deleted) {
            deleted += 1
            continue
          }
          const changed = Object.fromEntries(
            written
              .filter(
                (field) =>
                  !sameValue(field.type, record.values[field.key], current.values[field.key]),
              )
              .map((field) => [field.key, record.values[field.key] ?? null]),
          )
          if (Object.keys(changed).length === 0) unchanged += 1
          else updates.push({ row: current, values: changed })
        }

        if (inserts.length > 0) {
          await RowService.insert(ctx, storage.id, inserts, tx, { importId: row.id })
        }
        let updated = 0
        let conflicts = 0
        for (const update of updates) {
          try {
            await RowService.update(
              ctx,
              storage.id,
              update.row.id,
              { values: update.values, ver: update.row.ver },
              tx,
              { importId: row.id },
            )
            updated += 1
          } catch (error) {
            // Строку правят сейчас вручную — обновится следующим опросом
            if (error instanceof AppError && error.code === 'conflict') conflicts += 1
            else throw error
          }
        }

        const [dataset] = await tx
          .select({ version: datasets.currentVersion })
          .from(datasets)
          .where(eq(datasets.id, storage.id))
          .limit(1)
        const version = dataset?.version ?? storage.currentVersion
        const [count] = await tx.execute<{ rows: number }>(
          sql`SELECT count(*)::int AS rows FROM ${sql.raw(qualified(storage.table))}
               WHERE _import_id = ${row.id}::uuid AND _deleted_at IS NULL`,
        )
        const stats = {
          rows: prepared.read,
          matched: prepared.records.length,
          inserted: inserts.length,
          updated,
          unchanged,
          skipped: prepared.skipped + deleted + conflicts,
          ...(prepared.reasons.length > 0 ? { reasons: prepared.reasons } : {}),
          version,
        }
        const message =
          prepared.skipped > 0
            ? `Пропущено записей: ${prepared.skipped} — ${prepared.reasons[0] ?? ''}`.trim()
            : null
        await tx
          .update(sources)
          .set({
            status: 'ok',
            statusMessage: message,
            rowCount: Number(count?.rows ?? 0),
            lastRunAt: sql`now()`,
            updatedAt: sql`now()`,
          })
          .where(eq(sources.id, row.id))
        await tx
          .update(sourceRuns)
          .set({ status: 'succeeded', stats, finishedAt: sql`now()` })
          .where(eq(sourceRuns.id, run.runId))
        if (row.integrationId) {
          await Integrations.recordSync(tx, ctx, {
            integrationId: row.integrationId,
            key: row.id,
            kind: 'feed',
            status: 'ok',
            message: `Лента «${object.title}»: новых ${inserts.length}, изменено ${updated}`,
            stats: { sourceId: row.id, ...stats },
          })
        }
        await publishEvent(tx, ctx, {
          type: 'source.synced',
          object: sourceEventObject(row.id, object),
          payload: {
            jobId: run.jobId,
            runId: run.runId,
            datasetId: storage.id,
            rows: prepared.read,
            inserted: inserts.length,
            updated,
            version,
          },
        })
        return { inserted: inserts.length, updated, version }
      })
      return {
        datasetId: storage.id,
        rows: prepared.read,
        inserted: outcome.inserted,
        updated: outcome.updated,
        version: outcome.version,
      }
    } catch (error) {
      // Сбой ленты повторами не лечится: причина — в статусе источника
      if (error instanceof AppError) throw new UnrecoverableError(error.message)
      throw error
    }
  },
}
