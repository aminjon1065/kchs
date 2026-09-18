import type { DatasetVersion } from '@kchs/contracts'
import { and, desc, eq, gt, inArray, sql } from 'drizzle-orm'
import { publishEvent } from '~/kernel/events/publisher.js'
import { actorId, type Ctx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import { pgErrorCode, UNIQUE_VIOLATION } from '~/shared/db/pg-error.js'
import { datasets, datasetVersions, imports, objects } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { historyName, ident, Physical, qualified } from '../infra/physical.js'
import { DatasetService, type StoredField } from './dataset-service.js'
import { selectList, valueSql, valuesOf, writeHistory } from './row-service.js'

const ACTIVE_IMPORTS = ['queued', 'normalizing', 'loading']
const IMPORT_MODES: Record<string, string> = {
  replace: 'заменить',
  upsert: 'обновить по ключу',
  sync: 'синхронизировать',
}

type HistoryOp = 'i' | 'u' | 'd'

type HistoryEntry = {
  row_id: string
  op: HistoryOp
  data: { values?: Record<string, unknown>; previous?: Record<string, unknown> } | null
}

interface LaterVersion {
  number: number
  origin: string
  importId: string | null
  diff: { added: number; updated: number; deleted: number } | null
}

/** Почему версию нельзя отменить: у неё нет прежних значений строк. */
function blockReason(origin: string, mode: string | undefined): string {
  if (origin === 'edit' || origin === 'rollback') {
    return 'история строк этой версии не сохранена (правка при выключенной истории)'
  }
  if (origin === 'schema') return 'между версиями менялась схема датасета'
  if (origin === 'import') {
    const name = mode ? (IMPORT_MODES[mode] ?? mode) : 'неизвестный'
    return `импорт в режиме «${name}» не хранит прежних значений — повторите импорт нужного файла`
  }
  return 'это создание датасета'
}

/**
 * Версии после целевой (от новых к старым) и первая, которую отменить нельзя.
 * Отменяются правки строк и прежние откаты — если история хранит каждую их
 * запись (по одной на строку счётчиков версии), и импорт «дополнить» (его
 * строки помечены `_import_id`).
 */
async function laterVersions(tx: Executor, datasetId: string, target: number) {
  const versions: LaterVersion[] = await tx
    .select({
      number: datasetVersions.number,
      origin: datasetVersions.origin,
      importId: datasetVersions.importId,
      diff: datasetVersions.diff,
    })
    .from(datasetVersions)
    .where(and(eq(datasetVersions.datasetId, datasetId), gt(datasetVersions.number, target)))
    .orderBy(desc(datasetVersions.number))
  const importIds = versions.flatMap((version) => (version.importId ? [version.importId] : []))
  const modes = new Map<string, string>()
  if (importIds.length > 0) {
    const rows = await tx
      .select({ id: imports.id, mode: imports.mode })
      .from(imports)
      .where(inArray(imports.id, importIds))
    for (const row of rows) modes.set(row.id, row.mode)
  }
  const logged = new Map<number, number>()
  const counted = await tx.execute<{ version: number; n: number }>(
    sql`SELECT dataset_version AS version, count(*)::int AS n
          FROM ${sql.raw(qualified(historyName(datasetId)))}
         WHERE dataset_version > ${target}
         GROUP BY dataset_version`,
  )
  for (const row of counted) logged.set(Number(row.version), Number(row.n))

  for (const version of versions) {
    const mode = version.importId ? modes.get(version.importId) : undefined
    if (version.origin === 'import' && mode === 'append') continue
    if (version.origin === 'edit' || version.origin === 'rollback') {
      const diff = version.diff ?? { added: 0, updated: 0, deleted: 0 }
      const expected = diff.added + diff.updated + diff.deleted
      if ((logged.get(version.number) ?? 0) >= expected) continue
    }
    return {
      versions,
      blocker: { number: version.number, reason: blockReason(version.origin, mode) },
    }
  }
  return { versions, blocker: null }
}

/**
 * Откат датасета к прежней версии (P1-E01 S04, ADR-0062): изменения после неё
 * отменяются от новых к старым, результат — новая версия `rollback`, которую
 * тоже можно отменить. Вставленные строки мягко удаляются, удалённые
 * возвращаются, изменённые получают прежние значения; каждая отмена пишется в
 * историю строк с номером новой версии.
 */
export const RollbackService = {
  async rollback(ctx: Ctx, datasetId: string, target: number): Promise<DatasetVersion> {
    const version = await revert(ctx, datasetId, target).catch((error: unknown) => {
      // Ключ хранят и удалённые строки: прежнее значение могло занять другое
      if (pgErrorCode(error) === UNIQUE_VIOLATION) {
        throw errors.conflict(
          `Откат к версии ${target} недоступен: прежнее значение ключа занято другой строкой`,
        )
      }
      throw error
    })
    const record = (await DatasetService.versions(datasetId)).find(
      (item) => item.number === version,
    )
    if (!record) throw errors.internal('Версия отката не найдена')
    return record
  },
}

/** Отмена версий после целевой в одной транзакции; возвращает номер новой версии. */
async function revert(ctx: Ctx, datasetId: string, target: number): Promise<number> {
  return db().transaction(async (tx) => {
    const [row] = await tx
      .select({ current: datasets.currentVersion })
      .from(datasets)
      .where(eq(datasets.id, datasetId))
      .for('update')
    if (!row) throw errors.notFound('Датасет')
    if (target < 1 || target >= row.current) {
      throw errors.validation('Откатить можно только к одной из прежних версий')
    }
    const [active] = await tx
      .select({ id: imports.id })
      .from(imports)
      .where(and(eq(imports.datasetId, datasetId), inArray(imports.status, ACTIVE_IMPORTS)))
      .limit(1)
    if (active) {
      throw errors.conflict('Идёт импорт в датасет — откатите версию после его завершения')
    }
    const storage = await DatasetService.storage(datasetId, tx)
    if (!storage.settings.trackHistory) {
      throw errors.conflict('История строк датасета выключена — откат версий недоступен')
    }
    const { versions, blocker } = await laterVersions(tx, datasetId, target)
    if (blocker) {
      throw errors.conflict(
        `Откат к версии ${target} недоступен: версия ${blocker.number} — ${blocker.reason}`,
        { blocker },
      )
    }

    // Номер новой версии известен заранее: датасет заблокирован, отмены помечаются им
    const next = row.current + 1
    const userId = actorId(ctx)
    const table = sql.raw(qualified(storage.table))
    const history = sql.raw(qualified(historyName(datasetId)))
    const byKey = new Map(storage.fields.map((field) => [field.key, field]))
    const counters = { added: 0, updated: 0, deleted: 0 }
    const written: Array<{ rowId: string; ver: number; op: HistoryOp; data: unknown }> = []

    for (const later of versions) {
      if (later.origin === 'import' && later.importId) {
        // Строки импорта «дополнить» — мягко удаляются одной командой
        const removed = await tx.execute<{ n: number }>(
          sql`WITH gone AS (
                  UPDATE ${table}
                     SET _deleted_at = now(), _updated_at = now(),
                         _updated_by = ${userId}::uuid, _ver = _ver + 1
                   WHERE _import_id = ${later.importId}::uuid AND _deleted_at IS NULL
               RETURNING _id, _ver
                ), logged AS (
                  INSERT INTO ${history} (row_id, ver, op, data, changed_by, dataset_version)
                  SELECT _id, _ver, 'd', NULL, ${userId}::uuid, ${next} FROM gone
               RETURNING 1
                )
                SELECT count(*)::int AS n FROM logged`,
        )
        counters.deleted += Number(removed[0]?.n ?? 0)
        continue
      }
      const entries = await tx.execute<HistoryEntry>(
        sql`SELECT row_id::text AS row_id, op, data FROM ${history}
               WHERE dataset_version = ${later.number} ORDER BY id DESC`,
      )
      for (const entry of entries) {
        if (entry.op === 'i') {
          const [gone] = await tx.execute<{ _ver: number }>(
            sql`UPDATE ${table}
                     SET _deleted_at = now(), _updated_at = now(),
                         _updated_by = ${userId}::uuid, _ver = _ver + 1
                   WHERE _id = ${entry.row_id}::bigint AND _deleted_at IS NULL
               RETURNING _ver`,
          )
          if (gone) {
            counters.deleted += 1
            written.push({ rowId: entry.row_id, ver: Number(gone._ver), op: 'd', data: null })
          }
        } else if (entry.op === 'd') {
          const [back] = await tx.execute<{ _ver: number }>(
            sql`UPDATE ${table}
                     SET _deleted_at = NULL, _updated_at = now(),
                         _updated_by = ${userId}::uuid, _ver = _ver + 1
                   WHERE _id = ${entry.row_id}::bigint AND _deleted_at IS NOT NULL
               RETURNING _ver`,
          )
          if (back) {
            counters.added += 1
            written.push({ rowId: entry.row_id, ver: Number(back._ver), op: 'i', data: null })
          }
        } else {
          const restored = await restoreValues(tx, table, entry, byKey, userId)
          if (restored) {
            counters.updated += 1
            written.push(restored)
          }
        }
      }
    }

    for (let start = 0; start < written.length; start += 1000) {
      await writeHistory(tx, storage, written.slice(start, start + 1000), userId, next)
    }
    const rowCount = await Physical.countRows(tx, storage.table)
    const created = await DatasetService.bumpVersion(tx, ctx, {
      datasetId,
      origin: 'rollback',
      rowCount,
      diff: counters,
    })
    if (created !== next) throw errors.internal('Номер версии отката разошёлся с ожидаемым')
    const [object] = await tx
      .select({ spaceId: objects.spaceId, title: objects.title })
      .from(objects)
      .where(eq(objects.id, datasetId))
      .limit(1)
    await publishEvent(tx, ctx, {
      type: 'dataset.rolled_back',
      object: {
        id: datasetId,
        type: 'dataset',
        spaceId: object?.spaceId ?? null,
        title: object?.title,
      },
      payload: { version: next, target, from: row.current },
    })
    return next
  })
}

/** Правка строки отменяется: прежние значения полей, которые ещё есть в схеме. */
async function restoreValues(
  tx: Executor,
  table: ReturnType<typeof sql.raw>,
  entry: HistoryEntry,
  byKey: Map<string, StoredField>,
  userId: string | null,
): Promise<{ rowId: string; ver: number; op: HistoryOp; data: unknown } | null> {
  const previous = entry.data?.previous ?? {}
  const fields = Object.keys(previous).flatMap((key) => {
    const field = byKey.get(key)
    return field ? [field] : []
  })
  if (fields.length === 0) return null
  const assignments = fields.map(
    (field) => sql`${sql.raw(ident(field.physical))} = ${valueSql(field, previous[field.key])}`,
  )
  const [row] = await tx.execute<Record<string, unknown>>(
    sql`UPDATE ${table} AS t
           SET ${sql.join(assignments, sql`, `)}, _ver = t._ver + 1, _updated_at = now(),
               _updated_by = ${userId}::uuid
          FROM (SELECT _id ${selectList(fields)} FROM ${table} WHERE _id = ${entry.row_id}::bigint) AS old
         WHERE t._id = old._id
     RETURNING t._ver AS _ver, old.*`,
  )
  if (!row) return null
  return {
    rowId: entry.row_id,
    ver: Number(row._ver),
    op: 'u',
    data: {
      values: Object.fromEntries(fields.map((field) => [field.key, previous[field.key] ?? null])),
      previous: valuesOf(row, fields),
    },
  }
}
