import type { LangText, UserRef } from '@kchs/contracts'
import {
  applyConditions,
  availableActions,
  DECISIONS_BY_TYPE,
  type ProcessAction,
  ProcessDefinition,
  type ProcessInstanceSummary,
  type ProcessInstanceView,
  type ProcessStepView,
  type StepEntry,
  type StepRun,
} from '@kchs/process'
import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import type { UserCtx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import {
  processDefinitions,
  processInstances,
  processStepActions,
  processSteps,
} from '~/shared/db/schema/index.js'
import { authorize, hasCapability } from '../access/authorize.js'
import { directory } from '../directory/port.js'
import { loadInstance, readContext } from './store.js'

/** Идущий маршрут объекта: текущие шаги решения и кто ждёт — для шапки карточки. */
export interface ActiveRoute {
  instanceId: string
  definitionKey: string
  name: LangText
  round: number
  steps: Array<{
    id: string
    key: string
    type: string
    name: LangText | null
    dueAt: string | null
    overdue: boolean
    pending: UserRef[]
  }>
}

/**
 * Чтение для экрана маршрута (ADR-0079): маршруты объекта и линия шагов с
 * назначенными, сроками, решениями и комментариями, действия смотрящего.
 * Смотреть маршрут может тот, кто видит объект.
 */

const OPEN = new Set(['pending', 'waiting'])

function missing(id: string): UserRef {
  return { id, displayName: '—', avatarUrl: null, position: null, unitName: null }
}

async function refsOf(ids: Iterable<string | null | undefined>): Promise<Map<string, UserRef>> {
  const unique = [...new Set([...ids].filter((id): id is string => Boolean(id)))]
  return unique.length > 0 ? directory().refs(unique) : new Map()
}

export const ProcessView = {
  /**
   * Идущие маршруты объекта с текущими шагами решения (ADR-0083): модуль
   * показывает их в карточке. Права проверяет вызывающий.
   */
  async active(executor: Executor, objectId: string): Promise<ActiveRoute[]> {
    const instances = await executor
      .select({
        id: processInstances.id,
        definitionKey: processInstances.definitionKey,
        context: processInstances.context,
        definition: processDefinitions.definition,
      })
      .from(processInstances)
      .innerJoin(processDefinitions, eq(processDefinitions.id, processInstances.definitionId))
      .where(and(eq(processInstances.objectId, objectId), eq(processInstances.status, 'running')))
      .orderBy(asc(processInstances.startedAt))
    if (instances.length === 0) return []
    const steps = await executor
      .select()
      .from(processSteps)
      .where(
        and(
          inArray(
            processSteps.instanceId,
            instances.map((row) => row.id),
          ),
          eq(processSteps.status, 'active'),
        ),
      )
      .orderBy(asc(processSteps.sequence))
    const decision = steps.filter((row) => Boolean(DECISIONS_BY_TYPE[row.kind as StepRun['type']]))
    const pendingOf = (row: (typeof steps)[number]) =>
      (row.assignees as unknown as StepEntry[])
        .filter((entry) => entry.state === 'pending')
        .map((entry) => entry.userId)
    const refs = await refsOf(decision.flatMap(pendingOf))
    const now = Date.now()
    return instances.map((instance) => {
      const context = readContext(instance.context)
      const base = ProcessDefinition.parse(instance.definition)
      const def = applyConditions(base, context.conditions)
      return {
        instanceId: instance.id,
        definitionKey: instance.definitionKey,
        name: base.name,
        round: context.round,
        steps: decision
          .filter((row) => row.instanceId === instance.id)
          .map((row) => ({
            id: row.id,
            key: row.stepKey,
            type: row.kind,
            name: def.steps[row.stepKey]?.name ?? null,
            dueAt: row.dueAt,
            overdue: Boolean(row.dueAt) && Date.parse(row.dueAt ?? '') < now,
            pending: pendingOf(row).map((id) => refs.get(id) ?? missing(id)),
          })),
      }
    })
  },

  async listForObject(ctx: UserCtx, objectId: string): Promise<ProcessInstanceSummary[]> {
    await authorize(ctx, 'view', objectId)
    const rows = await db()
      .select({
        instance: processInstances,
        version: processDefinitions.version,
        definition: processDefinitions.definition,
      })
      .from(processInstances)
      .innerJoin(processDefinitions, eq(processDefinitions.id, processInstances.definitionId))
      .where(eq(processInstances.objectId, objectId))
      .orderBy(desc(processInstances.startedAt))
    const refs = await refsOf(rows.map((row) => row.instance.startedBy))
    return rows.map((row) => ({
      id: row.instance.id,
      objectId: row.instance.objectId,
      definitionId: row.instance.definitionId,
      definitionKey: row.instance.definitionKey,
      version: row.version,
      name: ProcessDefinition.parse(row.definition).name,
      status: row.instance.status as ProcessInstanceSummary['status'],
      outcome: row.instance.outcome,
      round: readContext(row.instance.context).round,
      startedBy: row.instance.startedBy
        ? (refs.get(row.instance.startedBy) ?? missing(row.instance.startedBy))
        : null,
      startedAt: row.instance.startedAt,
      finishedAt: row.instance.finishedAt,
    }))
  },

  async get(ctx: UserCtx, instanceId: string): Promise<ProcessInstanceView> {
    const loaded = await loadInstance(db(), instanceId)
    await authorize(ctx, 'view', loaded.object.id)
    const { instance, state, def } = loaded
    const stepIds = state.steps.map((run) => run.id)
    const actions =
      stepIds.length > 0
        ? await db()
            .select()
            .from(processStepActions)
            .where(inArray(processStepActions.stepId, stepIds))
            .orderBy(asc(processStepActions.at))
        : []
    const actingFor = ctx.principals.actingFor.map((item) => item.userId)
    const mine = availableActions(def, state, { userId: ctx.userId, actingFor })

    const refs = await refsOf([
      instance.startedBy,
      ...state.steps.flatMap((run) =>
        run.entries.flatMap((entry) => [
          entry.userId,
          entry.actorId,
          entry.addedBy,
          entry.delegatedFrom,
          entry.delegatedTo,
        ]),
      ),
      ...actions.flatMap((action) => [action.actorId, action.onBehalfOf]),
      ...mine.map((item) => item.onBehalfOf),
    ])
    const ref = (id: string | null | undefined): UserRef | null =>
      id ? (refs.get(id) ?? missing(id)) : null

    const now = Date.now()
    const byStep = new Map<string, typeof actions>()
    for (const action of actions) {
      byStep.set(action.stepId, [...(byStep.get(action.stepId) ?? []), action])
    }
    const stepView = (run: StepRun): ProcessStepView => {
      const step = def.steps[run.key]
      const decision = Boolean(DECISIONS_BY_TYPE[run.type])
      return {
        id: run.id,
        key: run.key,
        type: run.type,
        name: step?.name ?? null,
        status: run.status,
        outcome: run.outcome,
        round: run.round,
        sequence: run.sequence,
        parentId: run.parentId,
        branch: run.branch,
        activatedAt: run.activatedAt,
        completedAt: run.completedAt,
        dueAt: run.dueAt,
        overdue: run.status === 'active' && Boolean(run.dueAt) && Date.parse(run.dueAt ?? '') < now,
        unassigned:
          run.status === 'active' &&
          run.resolved &&
          decision &&
          !run.entries.some((entry) => OPEN.has(entry.state)),
        assignees: run.entries.map((entry) => ({
          user: ref(entry.userId) as UserRef,
          state: entry.state,
          source: entry.source,
          decidedAt: entry.decidedAt,
          actor: ref(entry.actorId),
          addedBy: ref(entry.addedBy),
          delegatedFrom: ref(entry.delegatedFrom),
          delegatedTo: ref(entry.delegatedTo),
        })),
        actions: (byStep.get(run.id) ?? []).map((action) => ({
          id: action.id,
          action: action.action,
          actor: ref(action.actorId),
          onBehalfOf: ref(action.onBehalfOf),
          comment: action.comment,
          fileIds: Array.isArray(action.payload.fileIds)
            ? (action.payload.fileIds as string[])
            : [],
          at: action.at,
        })),
        result: run.result,
      }
    }

    const canCancel =
      state.status === 'running' &&
      (instance.startedBy === ctx.userId ||
        hasCapability(ctx, 'processes.manage') ||
        (await authorize(ctx, 'manage', loaded.object.id, { soft: true })).allowed)

    return {
      id: instance.id,
      objectId: instance.objectId,
      definitionId: instance.definitionId,
      definitionKey: instance.definitionKey,
      version: loaded.version,
      name: loaded.base.name,
      status: state.status,
      outcome: state.outcome,
      round: state.round,
      startedBy: ref(instance.startedBy),
      startedAt: instance.startedAt,
      finishedAt: instance.finishedAt,
      definition: def,
      variables: loaded.context.variables,
      steps: [...state.steps].sort((a, b) => a.sequence - b.sequence).map(stepView),
      myActions: mine.map((item) => ({
        stepId: item.stepId,
        stepKey: item.stepKey,
        type: item.type,
        onBehalfOf: ref(item.onBehalfOf),
        actions: item.actions as ProcessAction[],
        requireMfa: item.requireMfa,
      })),
      canCancel,
    }
  },
}
