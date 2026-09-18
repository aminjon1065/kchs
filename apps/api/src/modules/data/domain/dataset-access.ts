import { atLeast, type Level } from '@kchs/contracts'
import { eq } from 'drizzle-orm'
import { authorize } from '~/kernel/access/authorize.js'
import type { Ctx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import { datasetColumnPolicies, datasetRowPolicies } from '~/shared/db/schema/index.js'

/** Какие строки видит пользователь: все, никакие или по фильтрам политик (OR). */
export type RowPolicy =
  | { kind: 'all' }
  | { kind: 'none' }
  | { kind: 'filter'; filters: Array<Record<string, unknown>> }

/** Доступ пользователя к датасету: уровень и применённые к нему политики. */
export interface DatasetGrant {
  datasetId: string
  level: Level
  /** `manage` и выше (и системный контекст) видят все строки и столбцы. */
  unrestricted: boolean
  rows: RowPolicy
  /** Ключи скрытых полей: их нет ни в схеме, ни в данных, ни в профиле. */
  hidden: Set<string>
  /** Ключи маскируемых полей: значения заменяются маской, выборки не показываются. */
  masked: Set<string>
}

/** Ключ принципала политики в форме множества принципалов (`type:id`, `everyone`). */
function principalKey(type: string, id: string): string {
  return type === 'everyone' ? 'everyone' : `${type}:${id}`
}

/**
 * Единый слой доступа к строкам и столбцам датасета (03-access-model.md
 * «Строки и столбцы датасетов»): грид, профили, экспорт, запросы и тайлы
 * получают политики отсюда. Несколько политик строк объединяются через OR;
 * есть политики, но ни одна не подходит пользователю — строк нет (кроме `manage+`).
 */
export const DatasetAccess = {
  async resolve(
    ctx: Ctx,
    datasetId: string,
    action = 'view',
    executor: Executor = db(),
  ): Promise<DatasetGrant> {
    const decision = await authorize(ctx, action, datasetId)
    const unrestricted = ctx.kind === 'system' || atLeast(decision.level, 'manage')
    const grant: DatasetGrant = {
      datasetId,
      level: decision.level,
      unrestricted,
      rows: { kind: 'all' },
      hidden: new Set(),
      masked: new Set(),
    }
    if (unrestricted || ctx.kind !== 'user') return grant

    const keys = new Set(ctx.principals.keys)
    const applies = (policy: { principalType: string; principalId: string }) =>
      keys.has(principalKey(policy.principalType, policy.principalId))

    const [rowPolicies, columnPolicies] = await Promise.all([
      executor
        .select({
          principalType: datasetRowPolicies.principalType,
          principalId: datasetRowPolicies.principalId,
          filter: datasetRowPolicies.filter,
        })
        .from(datasetRowPolicies)
        .where(eq(datasetRowPolicies.datasetId, datasetId)),
      executor
        .select({
          principalType: datasetColumnPolicies.principalType,
          principalId: datasetColumnPolicies.principalId,
          mode: datasetColumnPolicies.mode,
          fields: datasetColumnPolicies.fields,
        })
        .from(datasetColumnPolicies)
        .where(eq(datasetColumnPolicies.datasetId, datasetId)),
    ])

    if (rowPolicies.length > 0) {
      const matching = rowPolicies.filter(applies)
      grant.rows =
        matching.length === 0
          ? { kind: 'none' }
          : { kind: 'filter', filters: matching.map((policy) => policy.filter) }
    }
    for (const policy of columnPolicies.filter(applies)) {
      for (const field of policy.fields) {
        if (policy.mode === 'hide') grant.hidden.add(field)
        else grant.masked.add(field)
      }
    }
    // Скрытие сильнее маскирования
    for (const field of grant.hidden) grant.masked.delete(field)
    return grant
  },
}
