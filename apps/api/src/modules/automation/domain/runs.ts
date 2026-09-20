import type {
  EventEnvelope,
  RuleRunListQuery,
  RuleRunRecord,
  RuleRunStatus,
  RuleRunStep,
  RuleTriggerKind,
} from '@kchs/contracts'
import { and, count, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm'
import { directory } from '~/kernel/directory/port.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import { JobService } from '~/kernel/jobs/service.js'
import { ObjectService } from '~/kernel/objects/service.js'
import type { Ctx } from '~/shared/context.js'
import { systemCtx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import { ruleDedupe, ruleRuns, rules } from '~/shared/db/schema/index.js'
import { newId } from '~/shared/ids.js'
import { logger } from '~/shared/logger/index.js'

/**
 * Журнал запусков правил (contracts/automation-rule.md §Правила исполнения):
 * запись создаётся в той же транзакции, что и задание очереди `automation`,
 * и хранит повод, лог шагов и диагностику. Идемпотентность по `(rule, event)`
 * — уникальный индекс: повторная доставка события не создаёт второй запуск.
 */
export const RULE_RUN_JOB = { queue: 'automation', name: 'rule.run' } as const

export interface QueueRunInput {
  ruleId: string
  triggerKind: RuleTriggerKind
  eventId?: string | null
  eventType?: string | null
  objectId?: string | null
  runAs: string | null
  depth?: number
  /** Конверт события или данные запуска: воркер исполняет по ним. */
  context: Record<string, unknown>
  /** Задержка перед исполнением (продолжение после `wait`). */
  delayMs?: number
}

export const RuleRuns = {
  /**
   * Ставит запуск в очередь. Возвращает `null`, если запуск по этому событию
   * уже есть: повторная доставка ничего не дублирует.
   */
  async queue(tx: Executor, ctx: Ctx, input: QueueRunInput): Promise<string | null> {
    const id = newId()
    const inserted = await tx
      .insert(ruleRuns)
      .values({
        id,
        ruleId: input.ruleId,
        eventId: input.eventId ?? null,
        eventType: input.eventType ?? null,
        triggerKind: input.triggerKind,
        status: 'queued',
        objectId: input.objectId ?? null,
        actorId: input.runAs,
        depth: input.depth ?? 0,
        context: input.context,
      })
      .onConflictDoNothing()
      .returning({ id: ruleRuns.id })
    if (inserted.length === 0) return null

    await JobService.schedule(tx, ctx, {
      ...RULE_RUN_JOB,
      data: { runId: id },
      objectId: input.objectId ?? null,
      idempotencyKey: `rule.run:${id}`,
      options: { attempts: 3, ...(input.delayMs ? { delay: input.delayMs } : {}) },
    })
    return id
  },

  /** Продолжение после `wait`: то же задание с задержкой. */
  async resume(runId: string, delayMs: number): Promise<void> {
    await db().transaction((tx) =>
      JobService.schedule(tx, systemCtx('rule.wait'), {
        ...RULE_RUN_JOB,
        data: { runId },
        idempotencyKey: `rule.run:${runId}:${Date.now()}`,
        options: { attempts: 3, delay: delayMs },
      }),
    )
  },

  async load(runId: string) {
    const [row] = await db().select().from(ruleRuns).where(eq(ruleRuns.id, runId)).limit(1)
    return row ?? null
  },

  async start(runId: string): Promise<void> {
    await db()
      .update(ruleRuns)
      .set({ status: 'running', startedAt: sql`now()`, error: null })
      .where(eq(ruleRuns.id, runId))
  },

  async appendStep(runId: string, step: RuleRunStep): Promise<void> {
    await db()
      .update(ruleRuns)
      .set({ steps: sql`${ruleRuns.steps} || ${JSON.stringify([step])}::jsonb` })
      .where(eq(ruleRuns.id, runId))
  },

  async finish(
    runId: string,
    status: RuleRunStatus,
    options: { error?: string | null; resumeAt?: number; waitUntil?: string } = {},
  ): Promise<void> {
    const finished = status !== 'waiting'
    await db()
      .update(ruleRuns)
      .set({
        status,
        error: options.error ?? null,
        ...(options.resumeAt !== undefined ? { resumeAt: options.resumeAt } : {}),
        // Момент продолжения после `wait`: по нему обход находит потерянное задание
        ...(options.waitUntil
          ? {
              context: sql`${ruleRuns.context} || ${JSON.stringify({ waitUntil: options.waitUntil })}::jsonb`,
            }
          : {}),
        ...(finished ? { finishedAt: sql`now()` } : {}),
      })
      .where(eq(ruleRuns.id, runId))
  },

  /**
   * Пропуск запуска с причиной. Чтобы лимит не превращался в поток записей,
   * одинаковая причина фиксируется не чаще раза в минуту.
   */
  async recordSkip(
    ruleId: string,
    input: { triggerKind: RuleTriggerKind; reason: string; eventId?: string | null },
  ): Promise<void> {
    const [recent] = await db()
      .select({ id: ruleRuns.id })
      .from(ruleRuns)
      .where(
        and(
          eq(ruleRuns.ruleId, ruleId),
          eq(ruleRuns.status, 'skipped'),
          sql`${ruleRuns.createdAt} > now() - interval '1 minute'`,
          eq(ruleRuns.error, input.reason),
        ),
      )
      .limit(1)
    if (recent) return
    await db()
      .insert(ruleRuns)
      .values({
        id: newId(),
        ruleId,
        eventId: input.eventId ?? null,
        triggerKind: input.triggerKind,
        status: 'skipped',
        error: input.reason,
        context: {},
        finishedAt: sql`now()`,
      })
  },

  /**
   * Лимит запусков в час (`limits.maxRunsPerHour`): считаются настоящие
   * запуски, пропуски в счёт не идут.
   */
  async withinLimit(ruleId: string, maxRunsPerHour: number): Promise<boolean> {
    const [row] = await db()
      .select({ total: count() })
      .from(ruleRuns)
      .where(
        and(
          eq(ruleRuns.ruleId, ruleId),
          sql`${ruleRuns.status} <> 'skipped'`,
          sql`${ruleRuns.createdAt} > now() - interval '1 hour'`,
        ),
      )
    return (row?.total ?? 0) < maxRunsPerHour
  },

  /**
   * Ключ дедупликации: первый запуск в окне занимает ключ, остальные
   * пропускаются. Вставка с `on conflict do nothing` решает это атомарно.
   */
  async claimDedupe(ruleId: string, key: string, windowMinutes: number): Promise<boolean> {
    await db()
      .delete(ruleDedupe)
      .where(and(eq(ruleDedupe.ruleId, ruleId), lt(ruleDedupe.expiresAt, sql`now()`)))
    const claimed = await db()
      .insert(ruleDedupe)
      .values({
        ruleId,
        key,
        expiresAt: sql`now() + make_interval(mins => ${windowMinutes})` as unknown as string,
      })
      .onConflictDoNothing()
      .returning({ key: ruleDedupe.key })
    return claimed.length > 0
  },

  /**
   * Глубина каузальной цепочки события и правила, которые уже сработали на
   * его причину: событие правила не запускает то же правило, а цепочка длиннее
   * пяти звеньев обрывается (contracts/automation-rule.md §Правила исполнения).
   */
  async causalChain(event: EventEnvelope): Promise<{ depth: number; ruleIds: string[] }> {
    if (!event.causationId) return { depth: 0, ruleIds: [] }
    const rows = await db()
      .select({ ruleId: ruleRuns.ruleId, depth: ruleRuns.depth })
      .from(ruleRuns)
      .where(eq(ruleRuns.eventId, event.causationId))
      .limit(50)
    if (rows.length === 0) return { depth: 1, ruleIds: [] }
    return {
      depth: Math.max(...rows.map((row) => row.depth)) + 1,
      ruleIds: [...new Set(rows.map((row) => row.ruleId))],
    }
  },

  async list(
    ruleId: string,
    query: RuleRunListQuery,
  ): Promise<{ items: RuleRunRecord[]; total: number }> {
    const conditions = [eq(ruleRuns.ruleId, ruleId)]
    if (query.status) conditions.push(eq(ruleRuns.status, query.status))
    const where = and(...conditions)
    const [{ total = 0 } = { total: 0 }] = await db()
      .select({ total: count() })
      .from(ruleRuns)
      .where(where)
    const rows = await db()
      .select()
      .from(ruleRuns)
      .where(where)
      .orderBy(desc(ruleRuns.createdAt))
      .limit(query.limit)
      .offset(query.offset)
    return { items: await toRecords(rows), total }
  },

  async get(runId: string): Promise<RuleRunRecord | null> {
    const row = await RuleRuns.load(runId)
    if (!row) return null
    const [record] = await toRecords([row])
    return record ?? null
  },

  /** Сбой запуска: журнал и событие — по нему владелец получает уведомление. */
  async fail(runId: string, ruleId: string, error: string, actionIndex: number | null) {
    await RuleRuns.finish(runId, 'failed', { error })
    await db().transaction(async (tx) => {
      await publishEvent(tx, systemCtx('rule.run'), {
        type: 'rule.run_failed',
        object: { id: ruleId, type: 'rule' },
        payload: { runId, ruleId, error: error.slice(0, 1000), actionIndex },
      })
    })
    logger().warn({ runId, ruleId, error }, 'правило автоматизации не выполнено')
  },

  /** Обслуживание: журнал старше срока и просроченные ключи дедупликации. */
  async prune(days = 30): Promise<number> {
    await db().delete(ruleDedupe).where(lt(ruleDedupe.expiresAt, sql`now()`))
    const deleted = await db()
      .delete(ruleRuns)
      .where(lt(ruleRuns.createdAt, sql`now() - make_interval(days => ${days})`))
      .returning({ id: ruleRuns.id })
    return deleted.length
  },

  /**
   * Запуски, застрявшие без задания: очередь очищена или задание потеряно.
   * Ожидание (`wait`) считается потерянным, когда его момент прошёл давно.
   */
  async stale(olderThanMinutes = 10): Promise<string[]> {
    const rows = await db()
      .select({ id: ruleRuns.id })
      .from(ruleRuns)
      .where(
        and(
          isNull(ruleRuns.finishedAt),
          or(
            and(
              inArray(ruleRuns.status, ['queued', 'running']),
              lt(ruleRuns.createdAt, sql`now() - make_interval(mins => ${olderThanMinutes})`),
            ),
            and(
              eq(ruleRuns.status, 'waiting'),
              sql`(${ruleRuns.context} ->> 'waitUntil')::timestamptz
                    < now() - make_interval(mins => ${olderThanMinutes})`,
            ),
          ),
        ),
      )
      .limit(100)
    return rows.map((row) => row.id)
  },
}

type Row = typeof ruleRuns.$inferSelect

async function toRecords(rows: Row[]): Promise<RuleRunRecord[]> {
  if (rows.length === 0) return []
  const ruleIds = [...new Set(rows.map((row) => row.ruleId))]
  const names = new Map<string, Record<string, string>>()
  const definitions = await db()
    .select({ id: rules.id, definition: rules.definition })
    .from(rules)
    .where(inArray(rules.id, ruleIds))
  for (const row of definitions) {
    const name = (row.definition as { name?: Record<string, string> }).name
    if (name) names.set(row.id, name)
  }
  const objectIds = [...new Set(rows.map((row) => row.objectId).filter(Boolean))] as string[]
  const summaries = objectIds.length > 0 ? await ObjectService.summaries(objectIds) : new Map()
  const actorIds = [...new Set(rows.map((row) => row.actorId).filter(Boolean))] as string[]
  const refs = actorIds.length > 0 ? await directory().refs(actorIds) : new Map()

  return rows.map((row) => ({
    id: row.id,
    ruleId: row.ruleId,
    ruleName: (names.get(row.ruleId) as { ru: string } | undefined) ?? null,
    status: row.status as RuleRunStatus,
    triggerKind: row.triggerKind as RuleTriggerKind,
    eventId: row.eventId,
    eventType: row.eventType,
    objectId: row.objectId,
    objectTitle: row.objectId ? (summaries.get(row.objectId)?.title ?? null) : null,
    runAs: row.actorId ? (refs.get(row.actorId) ?? null) : null,
    depth: row.depth,
    steps: (row.steps as RuleRunStep[]) ?? [],
    error: row.error,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    createdAt: row.createdAt,
  }))
}
