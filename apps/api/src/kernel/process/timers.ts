import { completeStep, recipientList, resolveAssignees } from '@kchs/process'
import { and, asc, eq, isNotNull, lte, sql } from 'drizzle-orm'
import { systemCtx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { processSteps } from '~/shared/db/schema/index.js'
import { logger } from '~/shared/logger/index.js'
import { publishEvent } from '../events/publisher.js'
import { registerJobHandler } from '../jobs/runner.js'
import { queue } from '../jobs/service.js'
import { kernelDirectory } from './directory.js'
import { Execution, transition } from './engine.js'
import type { StepTimers } from './store.js'
import { instanceIdOfStep, loadInstance } from './store.js'
import { nextTimerAt, TIMER_JOB } from './timer-schedule.js'

/**
 * Срабатывание таймеров шагов (ADR-0079): напоминания за рабочий день и в
 * день срока, просрочка с эскалацией по `timers` определения, срок ожидания
 * `wait`. Обработчик идемпотентен: момент отмечается в строке шага под
 * блокировкой экземпляра, повтор задания ничего не дублирует. Обход таймеров
 * по расписанию подхватывает моменты, задание которых потеряно (очередь
 * очищена): состояние — только в базе.
 */
export const SWEEP_JOB = 'process.timers-sweep'

const ORDER = ['remindBefore', 'remindDue', 'overdue', 'wait'] as const

export async function fireStepTimers(stepId: string, now = new Date()): Promise<number> {
  return db().transaction(async (tx) => {
    const instanceId = await instanceIdOfStep(tx, stepId)
    if (!instanceId) return 0
    const loaded = await loadInstance(tx, instanceId, { lock: true })
    const run = loaded.state.steps.find((item) => item.id === stepId)
    const meta = loaded.meta.get(stepId)
    if (!run || !meta) return 0
    const ctx = systemCtx('process.timer')
    const execution = new Execution(tx, ctx, loaded)
    await execution.objectData()
    const timers: StepTimers = structuredClone(meta.timers)
    let fired = 0

    if (run.status === 'active' && loaded.state.status === 'running') {
      const pending = run.entries
        .filter((entry) => entry.state === 'pending')
        .map((entry) => entry.userId)
      const object = execution.eventObject()
      const base = {
        instanceId: loaded.instance.id,
        stepId: run.id,
        stepKey: run.key,
        kind: run.type,
      }
      for (const kind of ORDER) {
        const timer = timers[kind]
        if (!timer || timer.firedAt || Date.parse(timer.at) > now.getTime()) continue
        timer.firedAt = now.toISOString()
        fired += 1
        if (kind === 'remindBefore' || kind === 'remindDue') {
          if (pending.length === 0 || !run.dueAt) continue
          await publishEvent(tx, ctx, {
            type: 'process.step_due_soon',
            object,
            payload: {
              ...base,
              dueAt: run.dueAt,
              userIds: pending,
              when: kind === 'remindBefore' ? 'before' : 'due_day',
            },
          })
        } else if (kind === 'overdue') {
          await publishEvent(tx, ctx, {
            type: 'process.step_overdue',
            object,
            payload: {
              ...base,
              dueAt: run.dueAt ?? timer.at,
              userIds: pending,
              escalateTo: await escalation(execution, run.key, pending),
            },
          })
        } else {
          await execution.apply(
            transition(() =>
              completeStep(
                loaded.def,
                execution.state,
                { stepId: run.id, outcome: 'timeout' },
                execution.env(),
              ),
            ),
          )
        }
      }
    }

    loaded.meta.set(stepId, {
      ...meta,
      timers,
      nextTimerAt: run.status === 'active' ? nextTimerAt(timers) : null,
    })
    await execution.commit()
    return fired
  })
}

/** Получатели эскалации: `timers[].onOverdue[].to` для шага или `*`. */
async function escalation(
  execution: Execution,
  stepKey: string,
  pending: string[],
): Promise<string[]> {
  const { loaded } = execution
  const data = await execution.objectData()
  const expressions = loaded.def.timers
    .filter((timer) => timer.step === '*' || timer.step === stepKey)
    .flatMap((timer) => timer.onOverdue.flatMap((action) => recipientList(action.to)))
  if (expressions.length === 0) return []
  const variableTypes = Object.fromEntries(
    Object.entries(loaded.def.variables).map(([name, variable]) => [name, variable.type]),
  )
  const { assignees } = await resolveAssignees(
    expressions,
    {
      authorId: data.authorId,
      ...(data.authorUnitId !== undefined ? { authorUnitId: data.authorUnitId } : {}),
      initiatorId: loaded.instance.startedBy,
      spaceId: data.spaceId ?? loaded.object.spaceId,
      variables: loaded.context.variables,
      variableTypes,
      fields: data.fields,
      stepAssignees: pending,
    },
    kernelDirectory,
  )
  return assignees.map((item) => item.userId)
}

/**
 * Обход: шаги, ближайший момент которых прошёл давно (задание потеряно), —
 * срабатывают здесь. `graceSeconds` — сколько ждать задание по расписанию.
 */
export async function sweepTimers(options: { graceSeconds?: number } = {}): Promise<number> {
  const grace = options.graceSeconds ?? 60
  const rows = await db()
    .select({ id: processSteps.id })
    .from(processSteps)
    .where(
      and(
        eq(processSteps.status, 'active'),
        isNotNull(processSteps.nextTimerAt),
        lte(processSteps.nextTimerAt, sql`now() - make_interval(secs => ${grace})`),
      ),
    )
    .orderBy(asc(processSteps.nextTimerAt))
    .limit(200)
  let fired = 0
  for (const row of rows) {
    try {
      fired += await fireStepTimers(row.id)
    } catch (error) {
      logger().error({ err: error, stepId: row.id }, 'таймер шага маршрута не сработал')
    }
  }
  return fired
}

/** Обработчики очереди `process-timers` — в роли worker (ADR-0035). */
export function registerProcessJobs(): void {
  registerJobHandler({
    queue: 'process-timers',
    name: TIMER_JOB,
    concurrency: 4,
    handle: async (job) => ({ fired: await fireStepTimers(String(job.data.stepId)) }),
  })
  registerJobHandler({
    queue: 'process-timers',
    name: SWEEP_JOB,
    concurrency: 1,
    handle: async () => ({ fired: await sweepTimers() }),
  })
}

/** Обход таймеров по расписанию: раз в пять минут. */
export async function scheduleProcessTimers(): Promise<void> {
  await queue('process-timers').add(
    SWEEP_JOB,
    {},
    { repeat: { pattern: '*/5 * * * *' }, jobId: `cron:${SWEEP_JOB}` },
  )
}
