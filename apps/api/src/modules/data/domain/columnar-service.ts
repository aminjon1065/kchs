import {
  type ColumnarAdmin,
  type ColumnarAdminEntry,
  type ColumnarCopy,
  ColumnarSettings,
  type ColumnarSettingsPatch,
  type ColumnarStatus,
  type FieldType,
} from '@kchs/contracts'
import type { CompiledQuery } from '@kchs/query'
import { and, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import { z } from 'zod'
import { authorize, visibleObjectsSql } from '~/kernel/access/authorize.js'
import { AUDIT_ACTIONS, audit } from '~/kernel/audit/service.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import { JobService } from '~/kernel/jobs/service.js'
import { SETTING_KEYS, SettingsService } from '~/kernel/settings/service.js'
import { buckets, deleteObject } from '~/kernel/storage/s3.js'
import { type Ctx, systemCtx, type UserCtx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import { datasetColumnarCopies, datasets, objects } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { logger } from '~/shared/logger/index.js'
import { postEngine } from '../infra/engine.js'
import { DatasetService, type DatasetStorage } from './dataset-service.js'

/** Задание сборки копии — очередь движка (ADR-0035). */
export const COLUMNAR_BUILD_JOB = { queue: 'transform', name: 'columnar.build' } as const

/** Тайм-аут запроса к движку: как у интерактивного запроса плюс дорога. */
const ENGINE_MARGIN_MS = 10_000

/** Системные столбцы строки в копии; `_deleted_at` нужен условию компилятора. */
const SYSTEM_PLAN: ReadonlyArray<{ name: string; type: FieldType }> = [
  { name: '_id', type: 'integer' },
  { name: '_ver', type: 'integer' },
  { name: '_created_at', type: 'datetime' },
  { name: '_updated_at', type: 'datetime' },
  { name: '_created_by', type: 'user' },
  { name: '_updated_by', type: 'user' },
  { name: '_deleted_at', type: 'datetime' },
]

/** Типы полей, которые хранит Parquet: геометрия остаётся в Postgres (ADR-0109). */
const COLUMNAR_TYPES = new Set<FieldType>([
  'text',
  'long_text',
  'select',
  'identifier',
  'url',
  'email',
  'phone',
  'integer',
  'number',
  'decimal',
  'money',
  'percent',
  'duration',
  'boolean',
  'date',
  'datetime',
  'time',
  'multi_select',
  'user',
  'unit',
  'territory',
  'object_ref',
  'file',
  'json',
])

/** Ответ движка на запрос по копии. */
const EngineReply = z.object({
  columns: z.array(z.string()),
  rows: z.array(z.array(z.unknown())),
  rowCount: z.number().int().nullable().optional(),
})

export interface ColumnarSource {
  /** Имя таблицы в SQL диалекта DuckDB — то же, что физическая таблица Postgres. */
  table: string
  bucket: string
  key: string
}

type CopyRow = typeof datasetColumnarCopies.$inferSelect

/** Ключ файла копии: версия в имени — новая версия не перетирает прежний файл. */
function copyKey(datasetId: string, version: number): string {
  return `columnar/${datasetId}/v${version}.parquet`
}

/** Столбцы копии: системные плюс хранимые поля, кроме геометрии и вычисляемых. */
export function columnPlan(storage: DatasetStorage): Array<{ name: string; type: FieldType }> {
  const plan = [...SYSTEM_PLAN]
  const used = new Set(plan.map((column) => column.name))
  for (const field of storage.fields) {
    if (!field.physical || used.has(field.physical)) continue
    if (!COLUMNAR_TYPES.has(field.type)) continue
    used.add(field.physical)
    plan.push({ name: field.physical, type: field.type })
  }
  return plan
}

/**
 * Ключи полей, которых в колоночной копии нет (геометрия, вычисляемые).
 * Запрос, который их читает, компилятор DuckDB не соберёт — считает Postgres.
 */
export function columnarUnsupported(
  fields: ReadonlyArray<{ key: string; type: FieldType; physical: string }>,
): Set<string> {
  const missing = new Set<string>()
  for (const field of fields) {
    if (!field.physical || !COLUMNAR_TYPES.has(field.type)) missing.add(field.key)
  }
  return missing
}

function statusOf(row: CopyRow | undefined, datasetVersion: number): ColumnarStatus {
  if (!row) return 'none'
  if (row.status === 'ready' && row.version !== datasetVersion) return 'stale'
  return row.status as ColumnarStatus
}

async function copyRow(datasetId: string, executor: Executor = db()): Promise<CopyRow | undefined> {
  const [row] = await executor
    .select()
    .from(datasetColumnarCopies)
    .where(eq(datasetColumnarCopies.datasetId, datasetId))
    .limit(1)
  return row
}

async function datasetInfo(
  datasetId: string,
): Promise<{ currentVersion: number; rowCount: number; title: string; spaceId: string }> {
  const [row] = await db()
    .select({
      currentVersion: datasets.currentVersion,
      rowCount: datasets.rowCount,
      title: objects.title,
      spaceId: objects.spaceId,
    })
    .from(datasets)
    .innerJoin(objects, eq(objects.id, datasets.id))
    .where(eq(datasets.id, datasetId))
    .limit(1)
  if (!row?.spaceId) throw errors.notFound('Датасет')
  return { ...row, spaceId: row.spaceId }
}

function toCopy(
  datasetId: string,
  row: CopyRow | undefined,
  info: { currentVersion: number; rowCount: number },
  settings: ColumnarSettings,
): ColumnarCopy {
  const status = statusOf(row, info.currentVersion)
  return {
    datasetId,
    status,
    version: row?.version ?? null,
    datasetVersion: info.currentVersion,
    rowCount: row?.rowCount ?? null,
    sizeBytes: row?.sizeBytes ?? null,
    buildMs: row?.buildMs ?? null,
    builtAt: row?.builtAt ?? null,
    requestedAt: row?.requestedAt ?? null,
    error: row?.error ?? null,
    fresh: status === 'ready' && settings.enabled,
    eligible: settings.enabled && info.rowCount >= settings.minRows,
  }
}

/**
 * Колоночный tier (06-analytics-engine.md §19, ADR-0109). Копия версии датасета
 * в Parquet собирается заданием движка; тяжёлые агрегаты по ней считает DuckDB,
 * а политики строк и столбцов приходят внутри SQL компилятора — они те же, что
 * в Postgres-пути.
 */
export const ColumnarService = {
  async settings(): Promise<ColumnarSettings> {
    const raw = await SettingsService.get<unknown>(
      SETTING_KEYS.columnarTier,
      [{ scope: 'system' }],
      {},
    )
    const parsed = ColumnarSettings.safeParse(raw ?? {})
    return parsed.success ? parsed.data : ColumnarSettings.parse({})
  },

  async updateSettings(ctx: UserCtx, patch: ColumnarSettingsPatch): Promise<ColumnarSettings> {
    const before = await ColumnarService.settings()
    const after = ColumnarSettings.parse({ ...before, ...patch })
    await db().transaction(async (tx) => {
      await SettingsService.set(tx, ctx, 'system', null, SETTING_KEYS.columnarTier, after)
      await audit(
        ctx,
        {
          action: AUDIT_ACTIONS.settingsChanged,
          severity: 'notice',
          details: { setting: SETTING_KEYS.columnarTier, before, after },
        },
        tx,
      )
    })
    return after
  },

  /** Состояние копии для карточки датасета (уровень view). */
  async state(ctx: Ctx, datasetId: string): Promise<ColumnarCopy> {
    await authorize(ctx, 'view', datasetId)
    const [info, row, settings] = await Promise.all([
      datasetInfo(datasetId),
      copyRow(datasetId),
      ColumnarService.settings(),
    ])
    return toCopy(datasetId, row, info, settings)
  },

  /**
   * Ставит сборку копии текущей версии. Строка метаданных и задание пишутся в
   * одной транзакции (ADR-0036), поэтому задание не увидит данных раньше их
   * появления, а пользователь сразу видит «собирается».
   */
  async build(
    ctx: Ctx,
    datasetId: string,
    options: { auto?: boolean } = {},
  ): Promise<ColumnarCopy> {
    if (!options.auto) await authorize(ctx, 'manage', datasetId)
    const settings = await ColumnarService.settings()
    if (!settings.enabled) throw errors.validation('Колоночный tier выключен в администрировании')
    const storage = await DatasetService.storage(datasetId)
    const info = await datasetInfo(datasetId)
    const plan = columnPlan(storage)
    const key = copyKey(datasetId, info.currentVersion)

    const existing = await copyRow(datasetId)
    if (existing?.status === 'building' && existing.version === info.currentVersion) {
      return toCopy(datasetId, existing, info, settings)
    }

    await db().transaction(async (tx) => {
      const jobId = await JobService.schedule(tx, ctx, {
        queue: COLUMNAR_BUILD_JOB.queue,
        name: COLUMNAR_BUILD_JOB.name,
        data: {
          datasetId,
          version: info.currentVersion,
          table: storage.table,
          bucket: buckets.columnar(),
          key,
          columns: plan,
        },
        objectId: datasetId,
        options: { attempts: 2 },
      })
      await tx
        .insert(datasetColumnarCopies)
        .values({
          datasetId,
          status: 'building',
          version: info.currentVersion,
          key,
          jobId,
          error: null,
          requestedAt: sql`now()`,
        })
        .onConflictDoUpdate({
          target: datasetColumnarCopies.datasetId,
          set: {
            status: 'building',
            version: info.currentVersion,
            key,
            jobId,
            error: null,
            requestedAt: sql`now()`,
            updatedAt: sql`now()`,
          },
        })
      await publishEvent(tx, ctx, {
        type: 'dataset.columnar_build_started',
        object: { id: datasetId, type: 'dataset', spaceId: info.spaceId, title: info.title },
        payload: { version: info.currentVersion },
      })
    })
    const row = await copyRow(datasetId)
    return toCopy(datasetId, row, info, settings)
  },

  /** Итог задания сборки: метаданные копии и событие; прежний файл удаляется. */
  async finish(
    datasetId: string,
    result: { rows: number; size: number; buildMs: number; key: string },
  ): Promise<void> {
    const previous = await copyRow(datasetId)
    const info = await datasetInfo(datasetId)
    await db().transaction(async (tx) => {
      await tx
        .update(datasetColumnarCopies)
        .set({
          status: 'ready',
          rowCount: result.rows,
          sizeBytes: result.size,
          buildMs: result.buildMs,
          key: result.key,
          error: null,
          builtAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(eq(datasetColumnarCopies.datasetId, datasetId))
      await publishEvent(tx, systemCtx('data.columnar'), {
        type: 'dataset.columnar_built',
        object: { id: datasetId, type: 'dataset', spaceId: info.spaceId, title: info.title },
        payload: { version: previous?.version ?? info.currentVersion, rows: result.rows },
      })
    })
    if (previous?.key && previous.key !== result.key) {
      await deleteObject(previous.key, buckets.columnar()).catch((error: unknown) =>
        logger().warn({ err: error, key: previous.key }, 'прежняя колоночная копия не удалена'),
      )
    }
  },

  /** Сбой сборки: копия помечена, причина видна в карточке и администрировании. */
  async markFailed(datasetId: string, reason: string): Promise<void> {
    await db()
      .update(datasetColumnarCopies)
      .set({ status: 'failed', error: reason.slice(0, 1000), updatedAt: sql`now()` })
      .where(eq(datasetColumnarCopies.datasetId, datasetId))
  },

  /**
   * Новая версия данных: копия устарела. Датасет крупнее порога — сборка
   * ставится сама, иначе метка остаётся до ручной пересборки.
   */
  async onVersionCreated(ctx: Ctx, datasetId: string): Promise<void> {
    const row = await copyRow(datasetId)
    const settings = await ColumnarService.settings()
    if (!settings.enabled) return
    const info = await datasetInfo(datasetId).catch(() => null)
    if (!info) return
    const known = row !== undefined
    if (!known && info.rowCount < settings.minRows) return
    if (row?.status === 'building') return
    if (row && row.version === info.currentVersion && row.status === 'ready') return
    if (!known || info.rowCount >= settings.minRows) {
      await ColumnarService.build(ctx, datasetId, { auto: true })
      return
    }
    await db()
      .update(datasetColumnarCopies)
      .set({ status: 'stale', updatedAt: sql`now()` })
      .where(eq(datasetColumnarCopies.datasetId, datasetId))
  },

  /**
   * Копия, годная для запроса прямо сейчас: собрана, той же версии, что данные,
   * и колоночный tier включён. Иначе — null, и запрос считает Postgres.
   */
  async ready(datasetId: string): Promise<ColumnarSource | null> {
    const settings = await ColumnarService.settings()
    if (!settings.enabled) return null
    const [row] = await db()
      .select({
        key: datasetColumnarCopies.key,
        status: datasetColumnarCopies.status,
        version: datasetColumnarCopies.version,
        table: datasets.physicalTable,
        currentVersion: datasets.currentVersion,
      })
      .from(datasetColumnarCopies)
      .innerJoin(datasets, eq(datasets.id, datasetColumnarCopies.datasetId))
      .where(eq(datasetColumnarCopies.datasetId, datasetId))
      .limit(1)
    if (!row?.key || row.status !== 'ready' || row.version !== row.currentVersion) return null
    return { table: row.table, bucket: buckets.columnar(), key: row.key }
  },

  /** Датасет крупнее порога — агрегаты по нему уходят в копию сами. */
  async large(datasetId: string): Promise<boolean> {
    const settings = await ColumnarService.settings()
    if (!settings.enabled) return false
    const [row] = await db()
      .select({ rowCount: datasets.rowCount })
      .from(datasets)
      .where(eq(datasets.id, datasetId))
      .limit(1)
    return (row?.rowCount ?? 0) >= settings.minRows
  },

  /**
   * Выполняет скомпилированный запрос в движке. Значения уходят параметрами,
   * политики уже внутри SQL: движок ничего не подставляет от себя.
   */
  async run(
    compiled: CompiledQuery,
    sources: ColumnarSource[],
    options: { count?: boolean } = {},
  ): Promise<{ rows: unknown[][]; columns: string[]; rowCount: number | null }> {
    const reply = EngineReply.parse(
      await postEngine(
        '/data/columnar/query',
        {
          sql: compiled.sql,
          params: compiled.params,
          ...(options.count
            ? { countSql: compiled.countSql, countParams: compiled.countParams }
            : {}),
          sources,
          timeoutMs: compiled.timeoutMs,
        },
        compiled.timeoutMs + ENGINE_MARGIN_MS,
      ),
    )
    return {
      rows: reply.rows as unknown[][],
      columns: reply.columns,
      rowCount: reply.rowCount ?? null,
    }
  },

  /** Список копий для администрирования: только видимые администратору датасеты. */
  async admin(ctx: UserCtx): Promise<ColumnarAdmin> {
    const settings = await ColumnarService.settings()
    const rows = await db()
      .select({
        datasetId: datasets.id,
        name: objects.title,
        spaceId: objects.spaceId,
        currentVersion: datasets.currentVersion,
        rowCount: datasets.rowCount,
        copy: datasetColumnarCopies,
      })
      .from(datasets)
      .innerJoin(objects, eq(objects.id, datasets.id))
      .leftJoin(datasetColumnarCopies, eq(datasetColumnarCopies.datasetId, datasets.id))
      .where(
        and(
          isNull(objects.deletedAt),
          visibleObjectsSql(ctx, 'dataset'),
          sql`(${datasets.rowCount} >= ${settings.minRows} OR ${datasetColumnarCopies.datasetId} IS NOT NULL)`,
        ),
      )
      .orderBy(desc(datasets.rowCount))
      .limit(200)
    const items: ColumnarAdminEntry[] = rows.map((row) => ({
      ...toCopy(
        row.datasetId,
        row.copy ?? undefined,
        { currentVersion: row.currentVersion, rowCount: row.rowCount },
        settings,
      ),
      name: row.name,
      spaceId: row.spaceId ?? row.datasetId,
    }))
    return { settings, items }
  },

  /** Датасеты, у которых копия отмечена заданием: для разбора итога задания. */
  async datasetOfJob(jobId: string): Promise<string | null> {
    const [row] = await db()
      .select({ datasetId: datasetColumnarCopies.datasetId })
      .from(datasetColumnarCopies)
      .where(and(eq(datasetColumnarCopies.jobId, jobId), isNotNull(datasetColumnarCopies.jobId)))
      .limit(1)
    return row?.datasetId ?? null
  },

  /** Удаление копий вместе с датасетами (используется тестами и очисткой). */
  async forget(datasetIds: string[]): Promise<void> {
    if (datasetIds.length === 0) return
    await db()
      .delete(datasetColumnarCopies)
      .where(inArray(datasetColumnarCopies.datasetId, datasetIds))
  },
}
