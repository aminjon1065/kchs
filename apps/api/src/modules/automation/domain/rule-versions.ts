import {
  RuleDefinition,
  type RuleVersion,
  type RuleVersionReason,
  type UserRef,
} from '@kchs/contracts'
import { desc, eq, max } from 'drizzle-orm'
import { directory } from '~/kernel/directory/port.js'
import { actorId, type Ctx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import { ruleVersions } from '~/shared/db/schema/index.js'
import { newId } from '~/shared/ids.js'

/** Сколько версий показывает история правила. */
const HISTORY_LIMIT = 50

/**
 * Версии определения правила (ADR-0163): пишутся в транзакции правки, откат — новая
 * версия со старым определением. Включение и выключение правила версией не считается.
 */
export const RuleVersions = {
  async record(
    tx: Executor,
    ctx: Ctx,
    ruleId: string,
    definition: RuleDefinition,
    reason: RuleVersionReason,
    changed: readonly string[] = [],
  ): Promise<number> {
    const [last] = await tx
      .select({ number: max(ruleVersions.number) })
      .from(ruleVersions)
      .where(eq(ruleVersions.ruleId, ruleId))
    const number = (last?.number ?? 0) + 1
    await tx.insert(ruleVersions).values({
      id: newId(),
      ruleId,
      number,
      definition: definition as unknown as Record<string, unknown>,
      reason,
      changed: [...changed],
      createdBy: actorId(ctx),
    })
    return number
  },

  async list(ruleId: string): Promise<RuleVersion[]> {
    const rows = await db()
      .select()
      .from(ruleVersions)
      .where(eq(ruleVersions.ruleId, ruleId))
      .orderBy(desc(ruleVersions.number))
      .limit(HISTORY_LIMIT)
    const refs = await directory().refs(
      rows.map((row) => row.createdBy).filter((id): id is string => Boolean(id)),
    )
    return rows.map((row) => ({
      id: row.id,
      number: row.number,
      reason: row.reason as RuleVersionReason,
      changed: row.changed as string[],
      createdBy: row.createdBy ? ((refs.get(row.createdBy) as UserRef | undefined) ?? null) : null,
      createdAt: row.createdAt,
      definition: RuleDefinition.parse(row.definition),
    }))
  },

  async get(ruleId: string, versionId: string): Promise<RuleDefinition | null> {
    const [row] = await db()
      .select({ ruleId: ruleVersions.ruleId, definition: ruleVersions.definition })
      .from(ruleVersions)
      .where(eq(ruleVersions.id, versionId))
      .limit(1)
    if (!row || row.ruleId !== ruleId) return null
    return RuleDefinition.parse(row.definition)
  },
}
