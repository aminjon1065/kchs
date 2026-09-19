import {
  DatasetCreateInput,
  type DatasetFieldInput,
  ImportMappingItem,
  type ImportRecord,
  ImportRunInput,
} from '@kchs/contracts'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { z } from 'zod'
import { EngineJobs } from '~/kernel/jobs/engine.js'
import { JobService } from '~/kernel/jobs/service.js'
import { ObjectService } from '~/kernel/objects/service.js'
import { headObject, readObjectText } from '~/kernel/storage/s3.js'
import { registerStoredFile } from '~/modules/files/public.js'
import type { Ctx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { imports, objects } from '~/shared/db/schema/index.js'
import { DatasetService } from './dataset-service.js'
import { ImportService } from './import-service.js'
import { SchemaService } from './schema-service.js'

/** seed генератора по умолчанию (`DEFAULT_SEED` движка): те же файлы на любой установке. */
export const DEMO_SEED = 2026
export const DEMO_PROFILES = ['small', 'demo'] as const
export type DemoProfile = (typeof DEMO_PROFILES)[number]

/** Набор манифеста `kchs-demo/1` (ADR-0054): что загрузить и как. */
const DemoEntry = z.object({
  id: z.string().regex(/^[a-z_]+$/),
  file: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  kind: z.enum(['table', 'reference']),
  description: z.string().max(2000),
  contentType: z.string().min(1),
  rows: z.number().int().nonnegative(),
  key: z.array(z.string()).max(8),
  timeField: z.string().nullable(),
  territoryField: z.string().nullable(),
  geometryField: z.string().nullable(),
  lookups: z.array(
    z.object({
      field: z.string(),
      dataset: z.string(),
      keyField: z.string(),
      labelField: z.string(),
    }),
  ),
  // ImportRunInput без fileId и target — проверяется контрактом при запуске
  import: z.looseObject({ mapping: z.array(ImportMappingItem).min(1) }),
})
type DemoEntry = z.infer<typeof DemoEntry>

const DemoManifest = z.object({
  format: z.literal('kchs-demo/1'),
  profile: z.string(),
  seed: z.number().int(),
  datasets: z.array(DemoEntry).min(1),
})
type DemoManifest = z.infer<typeof DemoManifest>

export interface DemoDataOptions {
  profile: DemoProfile
  spaceId: string
  seed?: number
  /** Предел ожидания генерации и каждого импорта, мс. */
  timeoutMs?: number
  /** Журнал хода загрузки (сид пишет его в консоль). */
  log?: (message: string, details?: Record<string, unknown>) => void
}

export interface DemoDataResult {
  datasets: number
  created: number
  rows: number
}

const POLL_MS = 1000
/** Задание генерации не взято за это время — движок, скорее всего, не запущен. */
const PICKUP_MS = 60_000
const TIMEOUTS: Record<DemoProfile, number> = { small: 10 * 60_000, demo: 60 * 60_000 }
/** Импорт сам больше не продвинется: завершён, отменён или ждёт публикации (ADR-0068). */
const FINISHED = new Set(['succeeded', 'failed', 'cancelled', 'review'])

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Манифест в хранилище — или null, если генерация ещё не закончилась. */
async function readManifest(key: string): Promise<DemoManifest | null> {
  const exists = await headObject(key)
    .then(() => true)
    .catch(() => false)
  if (!exists) return null
  return DemoManifest.parse(JSON.parse(await readObjectText(key)))
}

/**
 * Файлы и манифест: задание движка, затем ожидание манифеста. Манифест пишется
 * последним, поэтому его появление — признак готовности, даже если движок не смог
 * сообщить api о завершении.
 */
async function generated(
  ctx: Ctx,
  options: DemoDataOptions,
  seed: number,
  timeoutMs: number,
): Promise<{ prefix: string; manifest: DemoManifest }> {
  const prefix = `demo/${options.profile}-${seed}`
  const key = `${prefix}/manifest.json`
  const matches = (manifest: DemoManifest | null): manifest is DemoManifest =>
    manifest !== null && manifest.profile === options.profile && manifest.seed === seed

  const ready = await readManifest(key)
  if (matches(ready)) return { prefix, manifest: ready }

  const jobId = await EngineJobs.demoGenerate(ctx, { profile: options.profile, seed, prefix })
  await JobService.dispatch(jobId)
  options.log?.('генерация демо-данных в движке', { profile: options.profile, seed, jobId })
  const started = Date.now()
  for (;;) {
    await sleep(POLL_MS)
    const manifest = await readManifest(key)
    if (matches(manifest)) return { prefix, manifest }
    const job = await JobService.get(jobId)
    if (job?.status === 'failed' || job?.status === 'cancelled') {
      const reason = (job.error as { message?: unknown } | null)?.message
      throw new Error(`Генерация демо-данных не выполнена: ${String(reason ?? job.status)}`)
    }
    const waited = Date.now() - started
    if (job?.status === 'queued' && waited > PICKUP_MS) {
      throw new Error(
        'Движок не взял задание генерации демо-данных за минуту — запустите engine и worker',
      )
    }
    if (waited > timeoutMs) {
      throw new Error(`Генерация демо-данных не уложилась в ${Math.round(timeoutMs / 60_000)} мин`)
    }
  }
}

/** Датасет набора, созданный прежним запуском сида: отметка `meta.demo`, профиль и seed данных. */
async function existingDataset(
  spaceId: string,
  demoId: string,
): Promise<{ id: string; profile: string | null; seed: number | null } | null> {
  const [row] = await db()
    .select({
      id: objects.id,
      profile: sql<string | null>`${objects.meta}->>'demoProfile'`,
      seed: sql<number | null>`(${objects.meta}->>'demoSeed')::int`,
    })
    .from(objects)
    .where(
      and(
        eq(objects.type, 'dataset'),
        eq(objects.spaceId, spaceId),
        isNull(objects.deletedAt),
        sql`${objects.meta}->>'demo' = ${demoId}`,
      ),
    )
    .limit(1)
  return row ?? null
}

/** Последний импорт датасета: загруженный набор повторно не грузится. */
async function lastImport(datasetId: string): Promise<{ id: string; status: string } | null> {
  const [row] = await db()
    .select({ id: imports.id, status: imports.status })
    .from(imports)
    .where(eq(imports.datasetId, datasetId))
    .orderBy(sql`${imports.createdAt} DESC`)
    .limit(1)
  return row ?? null
}

/** Поля датасета из сопоставления манифеста; ключ, время и территория — с индексом. */
function fieldsOf(entry: DemoEntry): DatasetFieldInput[] {
  const indexed = new Set([
    ...entry.key,
    ...(entry.timeField ? [entry.timeField] : []),
    ...(entry.territoryField ? [entry.territoryField] : []),
    ...entry.lookups.map((lookup) => lookup.field),
  ])
  const fields = entry.import.mapping.map((item, index) => ({
    key: item.fieldKey,
    label: item.label,
    type: item.type,
    semantic: item.semantic,
    required: item.required,
    unique: false,
    indexed: indexed.has(item.fieldKey),
    sensitive: false,
    readOnly: false,
    nullable: !item.required,
    order: index,
    ...(item.format ? { format: item.format } : {}),
  }))
  if (entry.geometryField) {
    fields.push({
      key: entry.geometryField,
      label: { ru: 'Геометрия', en: 'Geometry' },
      type: 'geometry',
      semantic: 'geometry',
      required: false,
      unique: false,
      indexed: false,
      sensitive: false,
      readOnly: false,
      nullable: true,
      order: fields.length,
    })
  }
  return fields as DatasetFieldInput[]
}

/** Новый датасет набора со схемой, ключом, полями времени и территории. */
async function createDataset(ctx: Ctx, entry: DemoEntry, spaceId: string): Promise<string> {
  const input = DatasetCreateInput.parse({
    name: entry.name,
    description: entry.description,
    spaceId,
    kind: entry.kind,
    fields: fieldsOf(entry),
    primaryKey: entry.key,
    timeField: entry.timeField,
    territoryField: entry.territoryField,
  })
  return db().transaction(async (tx) => {
    const id = await DatasetService.create(tx, ctx, input)
    await ObjectService.update(
      tx,
      ctx,
      id,
      { meta: { demo: entry.id }, mergeMeta: true },
      { silent: true },
    )
    return id
  })
}

async function waitImport(importId: string, timeoutMs: number): Promise<ImportRecord> {
  const started = Date.now()
  for (;;) {
    const record = await ImportService.get(importId)
    if (FINISHED.has(record.status)) return record
    if (Date.now() - started > timeoutMs) {
      throw new Error(
        `Импорт не завершился за ${Math.round(timeoutMs / 60_000)} мин — проверьте api, worker и engine`,
      )
    }
    await sleep(POLL_MS)
  }
}

/**
 * Демо-данные фазы 1 (P1-E10, ADR-0063): генератор движка пишет файлы, сид
 * загружает их тем же конвейером, что и пользователь, — файл → датасет →
 * импорт. Справочники идут раньше таблиц, связи полей со справочниками ставятся
 * после создания. Повторный запуск загруженное тем же профилем не трогает;
 * другой профиль или seed заменяет строки импортом «заменить».
 */
export const DemoData = {
  async load(ctx: Ctx, options: DemoDataOptions): Promise<DemoDataResult> {
    const seed = options.seed ?? DEMO_SEED
    const timeoutMs = options.timeoutMs ?? TIMEOUTS[options.profile]
    const { prefix, manifest } = await generated(ctx, options, seed, timeoutMs)
    const ids = new Map<string, string>()
    let created = 0
    let rows = 0

    for (const entry of manifest.datasets) {
      const existing = await existingDataset(options.spaceId, entry.id)
      let datasetId = existing?.id ?? null
      let previous = datasetId ? await lastImport(datasetId) : null
      // Незавершённый импорт прежнего запуска сначала дожидается
      if (previous && !FINISHED.has(previous.status)) {
        previous = await waitImport(previous.id, timeoutMs)
      }
      const same = existing?.profile === options.profile && existing?.seed === seed
      if (datasetId && same && previous?.status === 'succeeded') {
        ids.set(entry.id, datasetId)
        options.log?.(`набор «${entry.name}» уже загружен`, { datasetId })
        continue
      }
      if (!datasetId) {
        datasetId = await createDataset(ctx, entry, options.spaceId)
        created += 1
        for (const lookup of entry.lookups) {
          const reference = lookup.dataset === entry.id ? datasetId : ids.get(lookup.dataset)
          if (!reference) continue
          await db().transaction((tx) =>
            SchemaService.updateField(tx, ctx, datasetId as string, lookup.field, {
              lookup: {
                datasetId: reference,
                keyField: lookup.keyField,
                labelField: lookup.labelField,
              },
            }),
          )
        }
      }
      ids.set(entry.id, datasetId)

      // Новый датасет дополняется; прежний (другой профиль или сбой) — заменяется целиком
      const file = await registerStoredFile(ctx, {
        spaceId: options.spaceId,
        name: entry.file,
        mime: entry.contentType.split(';')[0]?.trim() || 'application/octet-stream',
        sourceKey: `${prefix}/${entry.file}`,
      })
      const input = ImportRunInput.parse({
        ...entry.import,
        fileId: file.id,
        target: { kind: 'existing', datasetId, mode: existing ? 'replace' : 'append' },
      })
      const record = await db().transaction((tx) => ImportService.start(tx, ctx, input))
      if (record.jobId) await JobService.dispatch(record.jobId)
      options.log?.(`импорт набора «${entry.name}»`, { rows: entry.rows, importId: record.id })
      const done = await waitImport(record.id, timeoutMs)
      if (done.status !== 'succeeded') {
        const reason = done.message ?? done.errorSample[0]?.reason ?? 'причина неизвестна'
        throw new Error(`Импорт набора «${entry.name}» не выполнен: ${reason}`)
      }
      await db().transaction((tx) =>
        ObjectService.update(
          tx,
          ctx,
          datasetId as string,
          { meta: { demoProfile: options.profile, demoSeed: seed }, mergeMeta: true },
          { silent: true },
        ),
      )
      rows += done.stats.inserted
    }
    return { datasets: manifest.datasets.length, created, rows }
  },
}
