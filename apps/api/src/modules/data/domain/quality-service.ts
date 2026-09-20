import type {
  DatasetQuality,
  QualityKind,
  QualityRule,
  QualityRuleResult,
  QualityStatus,
} from '@kchs/contracts'
import { and, desc, eq, sql } from 'drizzle-orm'
import { authorize } from '~/kernel/access/authorize.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import { systemCtx, type UserCtx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import {
  datasetQualityRules,
  datasetQualityRuns,
  datasetVersions,
  objects,
} from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { newId } from '~/shared/ids.js'
import { ident, qualified } from '../infra/physical.js'
import { DatasetService, type DatasetStorage, type StoredField } from './dataset-service.js'

/**
 * Качество данных (06-analytics-engine.md §15, ADR-0101): правила проверяются
 * на текущей версии датасета — при её появлении заданием и по кнопке. Имена
 * столбцов берутся из реестра полей датасета, значения уходят параметрами:
 * пользовательский текст в SQL не попадает (правило 5 CLAUDE.md).
 */

/** Сколько нарушивших строк показываем: этого хватает, чтобы понять причину. */
const SAMPLE = 10

function fieldOf(storage: DatasetStorage, key: string | null): StoredField {
  const field = storage.fields.find((item) => item.key === key)
  if (!field) throw errors.validation(`Поля «${key}» в датасете нет`)
  return field
}

/** Условие «строка нарушает правило» — по виду правила. */
function violation(rule: QualityRule, field: StoredField | null) {
  const column = field ? sql.raw(ident(field.physical)) : null
  switch (rule.kind) {
    case 'not_null':
      return sql`${column} is null`
    case 'range': {
      const { min, max } = rule.params
      if (min === undefined && max === undefined) {
        throw errors.validation('Правилу диапазона нужны границы')
      }
      const low = min === undefined ? sql`false` : sql`${column} < ${min}`
      const high = max === undefined ? sql`false` : sql`${column} > ${max}`
      return sql`${column} is not null and (${low} or ${high})`
    }
    case 'regex': {
      const pattern = rule.params.pattern
      if (!pattern) throw errors.validation('Правилу шаблона нужно выражение')
      return sql`${column} is not null and ${column}::text !~ ${pattern}`
    }
    case 'in_set': {
      const values = rule.params.values ?? []
      if (values.length === 0) throw errors.validation('Правилу набора нужны значения')
      return sql`${column} is not null and not (${column}::text = any(${values}))`
    }
    case 'geometry_valid':
      return sql`${column} is not null and not extensions.ST_IsValid(${column})`
    case 'freshness': {
      const hours = rule.params.maxAgeHours
      if (!hours) throw errors.validation('Правилу свежести нужен срок в часах')
      return sql`${column} is null or ${column} < now() - make_interval(hours => ${hours})`
    }
    default:
      throw errors.internal(`Вид правила ${rule.kind} проверяется отдельно`)
  }
}

/** Виды, которые считаются построчно одним запросом с условием. */
const ROW_KINDS = new Set<QualityKind>([
  'not_null',
  'range',
  'regex',
  'in_set',
  'geometry_valid',
  'freshness',
])

async function checkRule(
  storage: DatasetStorage,
  rule: QualityRule,
  previousRows: number | null,
): Promise<QualityRuleResult> {
  const base: QualityRuleResult = {
    key: rule.key,
    kind: rule.kind,
    field: rule.field,
    severity: rule.severity,
    status: 'ok',
    failed: 0,
    checked: 0,
    sample: [],
    message: null,
  }
  const table = sql.raw(qualified(storage.table))

  try {
    if (rule.kind === 'row_count_delta') {
      const [row] = await db().execute<{ total: number }>(
        sql`select count(*)::int as total from ${table}`,
      )
      const total = Number(row?.total ?? 0)
      const limit = rule.params.maxDropPercent ?? 10
      const dropped =
        previousRows && previousRows > 0 ? ((previousRows - total) / previousRows) * 100 : 0
      const failed = dropped > limit
      return {
        ...base,
        checked: total,
        failed: failed ? 1 : 0,
        status: failed ? 'failed' : 'ok',
        message: failed
          ? `строк стало меньше на ${dropped.toFixed(1)} % (было ${previousRows}, стало ${total})`
          : null,
      }
    }

    if (rule.kind === 'unique') {
      const field = fieldOf(storage, rule.field)
      const column = sql.raw(ident(field.physical))
      const rows = await db().execute<{ total: number; sample: string }>(
        sql`select count(*)::int as total, min(_id::text) as sample
            from ${table}
            where ${column} is not null
            group by ${column}
            having count(*) > 1
            limit ${SAMPLE}`,
      )
      const duplicates = rows.reduce((sum, row) => sum + Number(row.total), 0)
      return {
        ...base,
        failed: duplicates,
        checked: duplicates,
        status: duplicates > 0 ? 'failed' : 'ok',
        sample: rows.map((row) => row.sample).filter(Boolean),
        message: duplicates > 0 ? `повторов значений: ${duplicates}` : null,
      }
    }

    if (rule.kind === 'referential') {
      const field = fieldOf(storage, rule.field)
      const targetId = rule.params.datasetId
      const targetKey = rule.params.datasetField
      if (!targetId || !targetKey) {
        throw errors.validation('Правилу ссылки нужны датасет и поле справочника')
      }
      const target = await DatasetService.storage(targetId)
      const targetField = fieldOf(target, targetKey)
      const column = sql.raw(ident(field.physical))
      const targetTable = sql.raw(qualified(target.table))
      const targetColumn = sql.raw(ident(targetField.physical))
      const rows = await db().execute<{ id: string }>(
        sql`select _id::text as id
            from ${table} as src
            where src.${column} is not null
              and not exists (
                select 1 from ${targetTable} as ref where ref.${targetColumn} = src.${column}
              )
            limit ${SAMPLE + 1}`,
      )
      const [count] = await db().execute<{ total: number }>(
        sql`select count(*)::int as total
            from ${table} as src
            where src.${column} is not null
              and not exists (
                select 1 from ${targetTable} as ref where ref.${targetColumn} = src.${column}
              )`,
      )
      const failed = Number(count?.total ?? 0)
      return {
        ...base,
        failed,
        checked: failed,
        status: failed > 0 ? 'failed' : 'ok',
        sample: rows.slice(0, SAMPLE).map((row) => row.id),
        message: failed > 0 ? `значений без пары в справочнике: ${failed}` : null,
      }
    }

    if (!ROW_KINDS.has(rule.kind)) throw errors.internal(`Неизвестный вид правила ${rule.kind}`)

    const field = fieldOf(storage, rule.field)
    const condition = violation(rule, field)
    const [count] = await db().execute<{ total: number; checked: number }>(
      sql`select count(*) filter (where ${condition})::int as total, count(*)::int as checked
          from ${table}`,
    )
    const failed = Number(count?.total ?? 0)
    const sample = failed
      ? await db().execute<{ id: string }>(
          sql`select _id::text as id from ${table} where ${condition} limit ${SAMPLE}`,
        )
      : []
    return {
      ...base,
      failed,
      checked: Number(count?.checked ?? 0),
      status: failed > 0 ? 'failed' : 'ok',
      sample: sample.map((row) => row.id),
      message: failed > 0 ? `строк с нарушением: ${failed}` : null,
    }
  } catch (error) {
    // Правило может стать невыполнимым: поле удалили, справочник недоступен
    return {
      ...base,
      status: 'error',
      message: error instanceof Error ? error.message.slice(0, 300) : 'правило не выполнилось',
    }
  }
}

function summarize(results: QualityRuleResult[]): QualityStatus {
  if (results.length === 0) return 'unknown'
  if (results.some((item) => item.status !== 'ok' && item.severity === 'error')) return 'failed'
  if (results.some((item) => item.status !== 'ok')) return 'warning'
  return 'ok'
}

async function rulesOf(datasetId: string, executor: Executor = db()): Promise<QualityRule[]> {
  const rows = await executor
    .select()
    .from(datasetQualityRules)
    .where(eq(datasetQualityRules.datasetId, datasetId))
  return rows.map((row) => ({
    key: row.key,
    kind: row.kind as QualityKind,
    field: row.field,
    params: row.params as QualityRule['params'],
    severity: row.severity as QualityRule['severity'],
    enabled: row.enabled,
  }))
}

export const QualityService = {
  /** Правила и последняя проверка; `canManage` — право менять правила. */
  async get(ctx: UserCtx, datasetId: string): Promise<DatasetQuality> {
    await authorize(ctx, 'view', datasetId)
    const rules = await rulesOf(datasetId)
    const [run] = await db()
      .select()
      .from(datasetQualityRuns)
      .where(eq(datasetQualityRuns.datasetId, datasetId))
      .orderBy(desc(datasetQualityRuns.checkedAt))
      .limit(1)
    return {
      status: (run?.status as QualityStatus) ?? 'unknown',
      version: run?.version ?? null,
      checkedAt: run?.checkedAt ?? null,
      rules,
      results: (run?.results ?? []) as QualityRuleResult[],
      canManage: (await authorize(ctx, 'manage', datasetId, { soft: true })).allowed,
    }
  },

  /** Замена набора правил: ключи уникальны в пределах датасета. */
  async setRules(ctx: UserCtx, datasetId: string, rules: QualityRule[]): Promise<void> {
    await authorize(ctx, 'manage', datasetId)
    const keys = new Set(rules.map((rule) => rule.key))
    if (keys.size !== rules.length) throw errors.validation('Ключи правил повторяются')
    const storage = await DatasetService.storage(datasetId)
    for (const rule of rules) {
      if (rule.kind === 'row_count_delta') continue
      fieldOf(storage, rule.field)
    }

    await db().transaction(async (tx) => {
      await tx.delete(datasetQualityRules).where(eq(datasetQualityRules.datasetId, datasetId))
      if (rules.length > 0) {
        await tx.insert(datasetQualityRules).values(
          rules.map((rule) => ({
            id: newId(),
            datasetId,
            key: rule.key,
            kind: rule.kind,
            field: rule.field,
            params: rule.params,
            severity: rule.severity,
            enabled: rule.enabled,
          })),
        )
      }
      await publishEvent(tx, ctx, {
        type: 'dataset.quality_rules_changed',
        object: await objectRef(tx, datasetId),
        payload: { rules: rules.length },
      })
    })
  },

  /** Прогон правил на текущей версии: результат сохраняется и публикуется. */
  async run(ctx: UserCtx, datasetId: string): Promise<DatasetQuality> {
    await authorize(ctx, 'view', datasetId)
    await QualityService.check(datasetId)
    return QualityService.get(ctx, datasetId)
  },

  /**
   * Проверка без пользователя (задание по новой версии). Возвращает сводку;
   * если правил нет, ничего не пишет.
   */
  async check(datasetId: string): Promise<QualityStatus> {
    const rules = (await rulesOf(datasetId)).filter((rule) => rule.enabled)
    if (rules.length === 0) return 'unknown'
    const storage = await DatasetService.storage(datasetId)

    const [previous] = await db()
      .select({ rowCount: datasetVersions.rowCount })
      .from(datasetVersions)
      .where(
        and(
          eq(datasetVersions.datasetId, datasetId),
          sql`${datasetVersions.number} < ${storage.currentVersion}`,
        ),
      )
      .orderBy(desc(datasetVersions.number))
      .limit(1)

    const results: QualityRuleResult[] = []
    for (const rule of rules) {
      results.push(await checkRule(storage, rule, previous?.rowCount ?? null))
    }
    const status = summarize(results)
    const ctx = systemCtx('data.quality')

    await db().transaction(async (tx) => {
      await tx.insert(datasetQualityRuns).values({
        id: newId(),
        datasetId,
        version: storage.currentVersion,
        status,
        results,
      })
      await publishEvent(tx, ctx, {
        type: 'dataset.quality_checked',
        object: await objectRef(tx, datasetId),
        payload: {
          version: storage.currentVersion,
          status,
          failed: results.filter((item) => item.status !== 'ok').length,
        },
      })
    })
    return status
  },

  /** Бейдж качества для каталога: статус последней проверки по датасетам. */
  async statuses(datasetIds: string[]): Promise<Map<string, QualityStatus>> {
    if (datasetIds.length === 0) return new Map()
    const rows = await db().execute<{ dataset_id: string; status: string }>(
      sql`select distinct on (dataset_id) dataset_id, status
          from dataset_quality_runs
          where dataset_id = any(${datasetIds})
          order by dataset_id, checked_at desc`,
    )
    return new Map(rows.map((row) => [row.dataset_id, row.status as QualityStatus]))
  },
}

/** Ссылка на объект датасета для события. */
async function objectRef(executor: Executor, datasetId: string) {
  const [row] = await executor
    .select({ id: objects.id, type: objects.type, spaceId: objects.spaceId, title: objects.title })
    .from(objects)
    .where(eq(objects.id, datasetId))
    .limit(1)
  if (!row) throw errors.notFound('Датасет')
  return row
}
