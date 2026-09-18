import {
  type DatasetColumnPolicy,
  type DatasetColumnPolicyInput,
  type DatasetColumnPolicyPatch,
  type DatasetPolicies,
  type DatasetRowPolicy,
  type DatasetRowPolicyInput,
  type DatasetRowPolicyPatch,
  FilterNode,
  isGroup,
  isNot,
  type Principal,
  type PrincipalRef,
  PrincipalType,
} from '@kchs/contracts'
import { and, asc, eq, sql } from 'drizzle-orm'
import { describePrincipals } from '~/kernel/access/principal-refs.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import { actorId, type Ctx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import { datasetColumnPolicies, datasetRowPolicies, objects } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { newId } from '~/shared/ids.js'
import { DatasetService, type DatasetStorage, type StoredField } from './dataset-service.js'
import { checkRowPolicy } from './query-service.js'

type PolicyKind = 'rows' | 'columns'
type PolicyOp = 'created' | 'updated' | 'deleted'

/** Не больше политик каждого вида на датасет: их объединение компилируется в каждый запрос. */
const MAX_POLICIES = 200

/** Поля, на которые ссылается фильтр политики. */
function filterFields(node: FilterNode): string[] {
  if (isNot(node)) return filterFields(node.not)
  if (isGroup(node)) return ('and' in node ? node.and : node.or).flatMap(filterFields)
  return [node.field]
}

function principalOf(row: { principalType: string; principalId: string }): Principal {
  return { type: PrincipalType.parse(row.principalType), id: row.principalId }
}

/** Отображаемый принципал; удалённый — с идентификатором вместо имени. */
function refOf(refs: Map<string, PrincipalRef>, principal: Principal): PrincipalRef {
  return refs.get(`${principal.type}:${principal.id}`) ?? { ...principal, title: principal.id }
}

/** Поля политики столбцов — из схемы датасета, без повторов. */
function checkColumnFields(storage: DatasetStorage, fields: string[]): string[] {
  const known = new Set(storage.fields.map((field) => field.key))
  for (const key of fields) {
    if (!known.has(key)) throw errors.validation(`Нет поля «${key}»`)
  }
  return [...new Set(fields)]
}

async function datasetStorage(tx: Executor, datasetId: string): Promise<DatasetStorage> {
  // Правки политик одного датасета — по очереди (предел числа политик)
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`dataset-policies:${datasetId}`}))`)
  return DatasetService.storage(datasetId, tx)
}

async function assertBelowLimit(tx: Executor, kind: PolicyKind, datasetId: string) {
  const table = kind === 'rows' ? datasetRowPolicies : datasetColumnPolicies
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(table)
    .where(eq(table.datasetId, datasetId))
  if ((row?.count ?? 0) >= MAX_POLICIES) {
    throw errors.validation(`У датасета не больше ${MAX_POLICIES} политик каждого вида`)
  }
}

/** Политики изменились — событие в той же транзакции (кэш запросов учитывает политики сам). */
async function policiesChanged(
  tx: Executor,
  ctx: Ctx,
  datasetId: string,
  payload: { kind: PolicyKind; op: PolicyOp; policyId: string },
): Promise<void> {
  const [object] = await tx
    .select({ spaceId: objects.spaceId, title: objects.title })
    .from(objects)
    .where(eq(objects.id, datasetId))
    .limit(1)
  await publishEvent(tx, ctx, {
    type: 'dataset.policies_changed',
    object: {
      id: datasetId,
      type: 'dataset',
      spaceId: object?.spaceId ?? null,
      title: object?.title,
    },
    payload,
  })
}

async function rowPolicy(tx: Executor, datasetId: string, policyId: string) {
  const [row] = await tx
    .select()
    .from(datasetRowPolicies)
    .where(and(eq(datasetRowPolicies.id, policyId), eq(datasetRowPolicies.datasetId, datasetId)))
    .limit(1)
  if (!row) throw errors.notFound('Политика строк')
  return row
}

async function columnPolicy(tx: Executor, datasetId: string, policyId: string) {
  const [row] = await tx
    .select()
    .from(datasetColumnPolicies)
    .where(
      and(eq(datasetColumnPolicies.id, policyId), eq(datasetColumnPolicies.datasetId, datasetId)),
    )
    .limit(1)
  if (!row) throw errors.notFound('Политика столбцов')
  return row
}

type RowPolicyRow = typeof datasetRowPolicies.$inferSelect
type ColumnPolicyRow = typeof datasetColumnPolicies.$inferSelect

function rowView(row: RowPolicyRow, refs: Map<string, PrincipalRef>): DatasetRowPolicy {
  return {
    id: row.id,
    principal: refOf(refs, principalOf(row)),
    filter: FilterNode.parse(row.filter),
    note: row.note,
    createdAt: new Date(row.createdAt).toISOString(),
  }
}

function columnView(row: ColumnPolicyRow, refs: Map<string, PrincipalRef>): DatasetColumnPolicy {
  return {
    id: row.id,
    principal: refOf(refs, principalOf(row)),
    mode: row.mode === 'hide' ? 'hide' : 'mask',
    fields: row.fields,
    createdAt: new Date(row.createdAt).toISOString(),
  }
}

const toRowPolicy = async (row: RowPolicyRow) =>
  rowView(row, await describePrincipals([principalOf(row)]))

const toColumnPolicy = async (row: ColumnPolicyRow) =>
  columnView(row, await describePrincipals([principalOf(row)]))

/**
 * Политики строк и столбцов датасета (03-access-model.md «Строки и столбцы
 * датасетов»): ведёт `manage+`, применяет слой DatasetAccess. Фильтр политики
 * строк проверяется компилятором запросов — сохранить можно только тот, что
 * выполнится при чтении.
 */
export const PolicyService = {
  async list(datasetId: string): Promise<DatasetPolicies> {
    const [rows, columns] = await Promise.all([
      db()
        .select()
        .from(datasetRowPolicies)
        .where(eq(datasetRowPolicies.datasetId, datasetId))
        .orderBy(asc(datasetRowPolicies.createdAt), asc(datasetRowPolicies.id)),
      db()
        .select()
        .from(datasetColumnPolicies)
        .where(eq(datasetColumnPolicies.datasetId, datasetId))
        .orderBy(asc(datasetColumnPolicies.createdAt), asc(datasetColumnPolicies.id)),
    ])
    const refs = await describePrincipals([...rows, ...columns].map(principalOf))
    return {
      rows: rows.map((row) => rowView(row, refs)),
      columns: columns.map((row) => columnView(row, refs)),
    }
  },

  async createRow(
    tx: Executor,
    ctx: Ctx,
    datasetId: string,
    input: DatasetRowPolicyInput,
  ): Promise<DatasetRowPolicy> {
    const storage = await datasetStorage(tx, datasetId)
    await assertBelowLimit(tx, 'rows', datasetId)
    checkRowPolicy(ctx, storage, input.filter)
    const [row] = await tx
      .insert(datasetRowPolicies)
      .values({
        id: newId(),
        datasetId,
        principalType: input.principal.type,
        principalId: input.principal.id,
        filter: input.filter as Record<string, unknown>,
        note: input.note?.trim() || null,
        createdBy: actorId(ctx),
      })
      .returning()
    if (!row) throw new Error('политика строк не сохранена')
    await policiesChanged(tx, ctx, datasetId, { kind: 'rows', op: 'created', policyId: row.id })
    return toRowPolicy(row)
  },

  async updateRow(
    tx: Executor,
    ctx: Ctx,
    datasetId: string,
    policyId: string,
    patch: DatasetRowPolicyPatch,
  ): Promise<DatasetRowPolicy> {
    const storage = await datasetStorage(tx, datasetId)
    await rowPolicy(tx, datasetId, policyId)
    if (patch.filter) checkRowPolicy(ctx, storage, patch.filter)
    const [row] = await tx
      .update(datasetRowPolicies)
      .set({
        ...(patch.principal
          ? { principalType: patch.principal.type, principalId: patch.principal.id }
          : {}),
        ...(patch.filter ? { filter: patch.filter as Record<string, unknown> } : {}),
        ...(patch.note !== undefined ? { note: patch.note?.trim() || null } : {}),
      })
      .where(eq(datasetRowPolicies.id, policyId))
      .returning()
    if (!row) throw errors.notFound('Политика строк')
    await policiesChanged(tx, ctx, datasetId, { kind: 'rows', op: 'updated', policyId })
    return toRowPolicy(row)
  },

  async removeRow(tx: Executor, ctx: Ctx, datasetId: string, policyId: string): Promise<void> {
    await datasetStorage(tx, datasetId)
    await rowPolicy(tx, datasetId, policyId)
    await tx.delete(datasetRowPolicies).where(eq(datasetRowPolicies.id, policyId))
    await policiesChanged(tx, ctx, datasetId, { kind: 'rows', op: 'deleted', policyId })
  },

  async createColumn(
    tx: Executor,
    ctx: Ctx,
    datasetId: string,
    input: DatasetColumnPolicyInput,
  ): Promise<DatasetColumnPolicy> {
    const storage = await datasetStorage(tx, datasetId)
    await assertBelowLimit(tx, 'columns', datasetId)
    const [row] = await tx
      .insert(datasetColumnPolicies)
      .values({
        id: newId(),
        datasetId,
        principalType: input.principal.type,
        principalId: input.principal.id,
        mode: input.mode,
        fields: checkColumnFields(storage, input.fields),
        createdBy: actorId(ctx),
      })
      .returning()
    if (!row) throw new Error('политика столбцов не сохранена')
    await policiesChanged(tx, ctx, datasetId, { kind: 'columns', op: 'created', policyId: row.id })
    return toColumnPolicy(row)
  },

  async updateColumn(
    tx: Executor,
    ctx: Ctx,
    datasetId: string,
    policyId: string,
    patch: DatasetColumnPolicyPatch,
  ): Promise<DatasetColumnPolicy> {
    const storage = await datasetStorage(tx, datasetId)
    await columnPolicy(tx, datasetId, policyId)
    const [row] = await tx
      .update(datasetColumnPolicies)
      .set({
        ...(patch.principal
          ? { principalType: patch.principal.type, principalId: patch.principal.id }
          : {}),
        ...(patch.mode ? { mode: patch.mode } : {}),
        ...(patch.fields ? { fields: checkColumnFields(storage, patch.fields) } : {}),
      })
      .where(eq(datasetColumnPolicies.id, policyId))
      .returning()
    if (!row) throw errors.notFound('Политика столбцов')
    await policiesChanged(tx, ctx, datasetId, { kind: 'columns', op: 'updated', policyId })
    return toColumnPolicy(row)
  },

  async removeColumn(tx: Executor, ctx: Ctx, datasetId: string, policyId: string): Promise<void> {
    await datasetStorage(tx, datasetId)
    await columnPolicy(tx, datasetId, policyId)
    await tx.delete(datasetColumnPolicies).where(eq(datasetColumnPolicies.id, policyId))
    await policiesChanged(tx, ctx, datasetId, { kind: 'columns', op: 'deleted', policyId })
  },

  /**
   * Поле удаляется из схемы: политика строк, которая на него ссылается, —
   * конфликт (иначе она перестанет компилироваться и закроет строки всем);
   * из политик столбцов ключ убирается, опустевшие удаляются.
   */
  async fieldRemoved(tx: Executor, ctx: Ctx, datasetId: string, key: string): Promise<void> {
    const rows = await tx
      .select({ filter: datasetRowPolicies.filter })
      .from(datasetRowPolicies)
      .where(eq(datasetRowPolicies.datasetId, datasetId))
    const used = rows.some((row) => {
      const parsed = FilterNode.safeParse(row.filter)
      return parsed.success && filterFields(parsed.data).includes(key)
    })
    if (used)
      throw errors.conflict('Поле используется в политике строк — сначала измените политику')

    const columns = await tx
      .select({ id: datasetColumnPolicies.id, fields: datasetColumnPolicies.fields })
      .from(datasetColumnPolicies)
      .where(
        and(
          eq(datasetColumnPolicies.datasetId, datasetId),
          sql`${key} = ANY(${datasetColumnPolicies.fields})`,
        ),
      )
    for (const policy of columns) {
      const fields = policy.fields.filter((field) => field !== key)
      if (fields.length === 0) {
        await tx.delete(datasetColumnPolicies).where(eq(datasetColumnPolicies.id, policy.id))
      } else {
        await tx
          .update(datasetColumnPolicies)
          .set({ fields })
          .where(eq(datasetColumnPolicies.id, policy.id))
      }
      await policiesChanged(tx, ctx, datasetId, {
        kind: 'columns',
        op: fields.length === 0 ? 'deleted' : 'updated',
        policyId: policy.id,
      })
    }
  },

  /**
   * Тип поля меняется: политики строк, которые на него ссылаются, должны
   * компилироваться и с новым типом — иначе конфликт до перезаписи таблицы.
   */
  async assertTypeChange(
    tx: Executor,
    ctx: Ctx,
    dataset: Pick<DatasetStorage, 'id' | 'table' | 'fields'>,
    key: string,
    type: StoredField['type'],
  ): Promise<void> {
    const rows = await tx
      .select({ filter: datasetRowPolicies.filter })
      .from(datasetRowPolicies)
      .where(eq(datasetRowPolicies.datasetId, dataset.id))
    const changed = {
      ...dataset,
      currentVersion: 0,
      fields: dataset.fields.map((field) => (field.key === key ? { ...field, type } : field)),
    }
    for (const row of rows) {
      const parsed = FilterNode.safeParse(row.filter)
      if (!parsed.success || !filterFields(parsed.data).includes(key)) continue
      try {
        checkRowPolicy(ctx, changed, parsed.data)
      } catch {
        throw errors.conflict(
          'С новым типом поля политика строк станет некорректной — сначала измените политику',
        )
      }
    }
  },
}
