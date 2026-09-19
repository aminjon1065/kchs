import {
  applyConditions,
  type InstanceState,
  ProcessDefinition,
  type StepEntry,
  type StepRun,
  type StepStatus,
  type StepType,
} from '@kchs/process'
import { asc, eq, sql } from 'drizzle-orm'
import type { Executor } from '~/shared/db/client.js'
import { processDefinitions, processInstances, processSteps } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { loadObject } from '../access/authorize.js'
import type { ObjectLike } from '../access/types.js'

/**
 * Хранение экземпляров: строка `process_instances` (состояние и контекст) и
 * строки `process_steps` (активации шагов). Всё состояние маршрута — в базе:
 * перезапуск api или worker ничего не теряет (сценарий приёмки фазы 3 №6).
 */

/** Контекст экземпляра (`process_instances.context`). */
export interface InstanceContext {
  variables: Record<string, unknown>
  /** Выбор инициатора: ключ шага → сотрудники (`chosen_by_initiator`). */
  chosen: Record<string, string[]>
  /** Номера условий запуска, которые выполнились. */
  conditions: number[]
  round: number
  seq: number
  reapproval: 'full' | 'rejecters_only'
  cancelReason?: string | null
}

/** Таймеры активации: моменты и отметки срабатывания. */
export interface StepTimer {
  at: string
  firedAt?: string | null
}

export type StepTimers = Partial<
  Record<'remindBefore' | 'remindDue' | 'overdue' | 'wait', StepTimer>
>

/** Поля строки шага, которыми управляет ядро, а не модель переходов. */
export interface StepMeta {
  timers: StepTimers
  nextTimerAt: string | null
  waitEvent: string | null
}

export interface LoadedInstance {
  instance: typeof processInstances.$inferSelect
  version: number
  /** Опубликованное определение версии. */
  base: ProcessDefinition
  /** Определение экземпляра — с шагами условий запуска. */
  def: ProcessDefinition
  context: InstanceContext
  state: InstanceState
  meta: Map<string, StepMeta>
  object: ObjectLike
}

type StepRow = typeof processSteps.$inferSelect

export function readContext(raw: Record<string, unknown>): InstanceContext {
  return {
    variables: (raw.variables as Record<string, unknown> | undefined) ?? {},
    chosen: (raw.chosen as Record<string, string[]> | undefined) ?? {},
    conditions: (raw.conditions as number[] | undefined) ?? [],
    round: Number(raw.round ?? 1),
    seq: Number(raw.seq ?? 0),
    reapproval: raw.reapproval === 'rejecters_only' ? 'rejecters_only' : 'full',
    cancelReason: (raw.cancelReason as string | null | undefined) ?? null,
  }
}

export function rowToRun(row: StepRow): StepRun {
  return {
    id: row.id,
    key: row.stepKey,
    type: row.kind as StepType,
    status: row.status as StepStatus,
    outcome: row.outcome,
    round: row.round,
    sequence: row.sequence,
    parentId: row.parentId,
    branch: row.branch,
    prevId: row.prevId,
    resolved: row.resolved,
    entries: row.assignees as unknown as StepEntry[],
    activatedAt: row.startedAt ?? row.updatedAt,
    completedAt: row.completedAt,
    dueAt: row.dueAt,
    result: row.result ?? null,
  }
}

export function rowMeta(row: StepRow): StepMeta {
  return {
    timers: (row.timers ?? {}) as StepTimers,
    nextTimerAt: row.nextTimerAt,
    waitEvent: row.waitEvent,
  }
}

/** Экземпляр шага для блокировки: сначала шаг, потом экземпляр `FOR UPDATE`. */
export async function instanceIdOfStep(tx: Executor, stepId: string): Promise<string | null> {
  const [row] = await tx
    .select({ instanceId: processSteps.instanceId })
    .from(processSteps)
    .where(eq(processSteps.id, stepId))
    .limit(1)
  return row?.instanceId ?? null
}

/**
 * Экземпляр со всеми активациями. `lock` — строка экземпляра `FOR UPDATE`:
 * все переходы одного маршрута (решения, таймеры, события) идут по очереди.
 */
export async function loadInstance(
  tx: Executor,
  instanceId: string,
  options: { lock?: boolean } = {},
): Promise<LoadedInstance> {
  const query = tx.select().from(processInstances).where(eq(processInstances.id, instanceId))
  const [instance] = options.lock ? await query.for('update') : await query
  if (!instance) throw errors.notFound('Маршрут')
  const [definition] = await tx
    .select({ version: processDefinitions.version, definition: processDefinitions.definition })
    .from(processDefinitions)
    .where(eq(processDefinitions.id, instance.definitionId))
    .limit(1)
  if (!definition) throw errors.internal('Определение маршрута не найдено')
  const object = await loadObject(instance.objectId, tx)
  if (!object) throw errors.notFound('Объект маршрута')

  const steps = await tx
    .select()
    .from(processSteps)
    .where(eq(processSteps.instanceId, instanceId))
    .orderBy(asc(processSteps.sequence))
  const context = readContext(instance.context)
  const base = ProcessDefinition.parse(definition.definition)
  const state: InstanceState = {
    status: instance.status as InstanceState['status'],
    outcome: instance.outcome,
    round: context.round,
    seq: context.seq,
    reapproval: context.reapproval,
    finishedAt: instance.finishedAt,
    steps: steps.map(rowToRun),
  }
  return {
    instance,
    version: definition.version,
    base,
    def: applyConditions(base, context.conditions),
    context,
    state,
    meta: new Map(steps.map((row) => [row.id, rowMeta(row)])),
    object,
  }
}

function stepValues(run: StepRun, meta: StepMeta) {
  return {
    stepKey: run.key,
    kind: run.type,
    status: run.status,
    assignees: run.entries as unknown as Array<Record<string, unknown>>,
    resolved: run.resolved,
    dueAt: run.dueAt,
    startedAt: run.activatedAt,
    completedAt: run.completedAt,
    outcome: run.outcome,
    result: run.result,
    sequence: run.sequence,
    round: run.round,
    parentId: run.parentId,
    branch: run.branch,
    prevId: run.prevId,
    timers: meta.timers as Record<string, unknown>,
    nextTimerAt: meta.nextTimerAt,
    waitEvent: meta.waitEvent,
  }
}

const EMPTY_META: StepMeta = { timers: {}, nextTimerAt: null, waitEvent: null }

/**
 * Запись разницы состояний: новые активации — вставка, изменённые —
 * обновление; строка экземпляра — статус, итог и контекст.
 */
export async function saveState(
  tx: Executor,
  loaded: LoadedInstance,
  before: InstanceState,
  after: InstanceState,
  metaBefore: ReadonlyMap<string, StepMeta>,
): Promise<void> {
  const previous = new Map(before.steps.map((run) => [run.id, run]))
  for (const run of after.steps) {
    const meta = loaded.meta.get(run.id) ?? EMPTY_META
    const old = previous.get(run.id)
    if (!old) {
      await tx
        .insert(processSteps)
        .values({ id: run.id, instanceId: loaded.instance.id, ...stepValues(run, meta) })
      continue
    }
    const changed =
      JSON.stringify(old) !== JSON.stringify(run) ||
      JSON.stringify(metaBefore.get(run.id) ?? EMPTY_META) !== JSON.stringify(meta)
    if (changed) {
      await tx
        .update(processSteps)
        .set({ ...stepValues(run, meta), updatedAt: sql`now()` })
        .where(eq(processSteps.id, run.id))
    }
  }
  const context: InstanceContext = {
    ...loaded.context,
    round: after.round,
    seq: after.seq,
    reapproval: after.reapproval,
  }
  loaded.context = context
  await tx
    .update(processInstances)
    .set({
      status: after.status,
      outcome: after.outcome,
      finishedAt: after.finishedAt,
      context: context as unknown as Record<string, unknown>,
      updatedAt: sql`now()`,
    })
    .where(eq(processInstances.id, loaded.instance.id))
}
