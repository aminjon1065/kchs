import type { EventEnvelope } from '@kchs/contracts'
import { completeStep } from '@kchs/process'
import { and, eq } from 'drizzle-orm'
import { systemCtx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { processInstances, processSteps } from '~/shared/db/schema/index.js'
import { usersWhoCanView } from '../access/explain.js'
import { recordModuleActivity } from '../activity/service.js'
import { directory } from '../directory/port.js'
import type { Subscriber } from '../events/types.js'
import { NotificationService } from '../notifications/service.js'
import { objectType } from '../objects/registry.js'
import { emitToRoom } from '../realtime/gateway.js'
import { Execution, evaluate, transition } from './engine.js'
import { waitableEvents } from './registry.js'
import { ProcessService } from './service.js'
import { loadInstance } from './store.js'

/**
 * Подписчики движка процессов (ADR-0079): уведомления участникам и
 * эскалации, лента активности объекта, обновление открытой вкладки, ожидание
 * событий шагами `wait`, отмена маршрутов объекта в корзине.
 */

const DECISION_KINDS = new Set(['approval', 'sign', 'acknowledge', 'register', 'return'])

/** Шаблон уведомления о назначении по типу шага. */
const ASSIGNED: Record<string, string> = {
  approval: 'notifications.tpl.processApprove',
  sign: 'notifications.tpl.processSign',
  acknowledge: 'notifications.tpl.processAcknowledge',
  register: 'notifications.tpl.processRegister',
  return: 'notifications.tpl.processRevise',
}

const DECIDED: Record<string, string> = {
  reject: 'notifications.tpl.processRejected',
  remarks: 'notifications.tpl.processRemarks',
  refuse: 'notifications.tpl.processRefused',
}

async function initiatorOf(instanceId: string): Promise<string | null> {
  const [row] = await db()
    .select({ startedBy: processInstances.startedBy })
    .from(processInstances)
    .where(eq(processInstances.id, instanceId))
    .limit(1)
  return row?.startedBy ?? null
}

/**
 * Получатели, которые объект не видят (руководитель просрочившего при
 * эскалации, адресат шага `notify`), получают уведомление без содержания:
 * без названия и ссылки на объект, только кто не ответил (ADR-0083).
 */
async function splitByAccess(
  objectId: string,
  userIds: string[],
): Promise<{ visible: string[]; hidden: string[] }> {
  const unique = [...new Set(userIds)]
  if (unique.length === 0) return { visible: [], hidden: [] }
  const visible = new Set(await usersWhoCanView(objectId, unique))
  return {
    visible: unique.filter((id) => visible.has(id)),
    hidden: unique.filter((id) => !visible.has(id)),
  }
}

async function namesOf(userIds: string[]): Promise<string> {
  if (userIds.length === 0) return '—'
  const refs = await directory().refs(userIds)
  return userIds.map((id) => refs.get(id)?.displayName ?? '—').join(', ')
}

async function notify(event: EventEnvelope): Promise<void> {
  if (!event.object) return
  const payload = event.payload as Record<string, unknown>
  const base = {
    objectId: event.object.id,
    actorId: event.actor.userId,
    url: objectType(event.object.type)?.route(event.object.id) ?? `/o/${event.object.id}`,
    params: { title: event.object.title ?? '' },
  }
  const ids = (value: unknown) => (Array.isArray(value) ? (value as string[]) : [])
  const kind = String(payload.kind ?? '')

  switch (event.type) {
    case 'process.step_activated': {
      const assignees = ids(payload.assignees)
      if (kind === 'notify') {
        const template = typeof payload.template === 'string' ? payload.template : null
        const { visible, hidden } = await splitByAccess(event.object.id, assignees)
        await NotificationService.notify({
          ...base,
          userIds: visible,
          category: 'object',
          titleKey: template
            ? `processes.templates.${template}`
            : 'notifications.tpl.processNotify',
          aggregateKey: `process:${String(payload.stepId)}`,
        })
        await NotificationService.notify({
          userIds: hidden,
          actorId: event.actor.userId,
          objectId: null,
          url: null,
          params: {},
          category: 'object',
          titleKey: 'notifications.tpl.processNotifyHidden',
          aggregateKey: `process:${String(payload.stepId)}:hidden`,
        })
        break
      }
      if (!DECISION_KINDS.has(kind)) break
      if (assignees.length === 0) {
        // Решать некому: инициатор узнаёт и обращается к администратору маршрутов
        const initiator = await initiatorOf(String(payload.instanceId))
        await NotificationService.notify({
          ...base,
          actorId: null,
          userIds: initiator ? [initiator] : [],
          category: 'inbox',
          titleKey: 'notifications.tpl.processUnassigned',
          aggregateKey: `process:${String(payload.stepId)}:unassigned`,
        })
        break
      }
      await NotificationService.notify({
        ...base,
        userIds: assignees,
        category: 'inbox',
        titleKey: ASSIGNED[kind] ?? 'notifications.tpl.inboxAssigned',
        aggregateKey: `process:${String(payload.stepId)}`,
      })
      break
    }
    case 'process.step_assignees_changed':
      await NotificationService.notify({
        ...base,
        userIds: ids(payload.added),
        category: 'inbox',
        titleKey: ASSIGNED[kind] ?? 'notifications.tpl.inboxAssigned',
        aggregateKey: `process:${String(payload.stepId)}`,
      })
      break
    case 'process.step_due_soon':
      await NotificationService.notify({
        ...base,
        actorId: null,
        userIds: ids(payload.userIds),
        category: 'inbox',
        titleKey:
          payload.when === 'before'
            ? 'notifications.tpl.processDueSoon'
            : payload.when === 'soon'
              ? 'notifications.tpl.processDueHours'
              : 'notifications.tpl.processDueToday',
        aggregateKey: `process:${String(payload.stepId)}:${String(payload.when)}`,
      })
      break
    case 'process.step_overdue':
      await NotificationService.notify({
        ...base,
        actorId: null,
        userIds: ids(payload.userIds),
        category: 'inbox',
        titleKey: 'notifications.tpl.processOverdue',
        aggregateKey: `process:${String(payload.stepId)}:overdue`,
      })
      {
        const { visible, hidden } = await splitByAccess(event.object.id, ids(payload.escalateTo))
        await NotificationService.notify({
          ...base,
          actorId: null,
          userIds: visible,
          category: 'inbox',
          titleKey: 'notifications.tpl.processEscalation',
          aggregateKey: `process:${String(payload.stepId)}:escalation`,
        })
        await NotificationService.notify({
          userIds: hidden,
          actorId: null,
          objectId: null,
          url: null,
          params: { people: await namesOf(ids(payload.userIds)) },
          category: 'inbox',
          titleKey: 'notifications.tpl.processEscalationHidden',
          aggregateKey: `process:${String(payload.stepId)}:escalation`,
        })
      }
      break
    case 'process.step_decided': {
      const titleKey = DECIDED[String(payload.decision)]
      if (!titleKey) break
      const initiator = await initiatorOf(String(payload.instanceId))
      // Имя решившего — в параметрах: заголовок уведомления переводится при выдаче
      const actor = event.actor.userId ? await directory().displayName(event.actor.userId) : ''
      await NotificationService.notify({
        ...base,
        params: { ...base.params, actor },
        userIds: initiator ? [initiator] : [],
        category: 'object',
        titleKey,
      })
      break
    }
    case 'process.finished': {
      const initiator = await initiatorOf(String(payload.instanceId))
      await NotificationService.notify({
        ...base,
        userIds: initiator ? [initiator] : [],
        category: 'object',
        titleKey:
          payload.status === 'cancelled'
            ? 'notifications.tpl.processCancelled'
            : payload.outcome === 'rejected'
              ? 'notifications.tpl.processFinishedRejected'
              : 'notifications.tpl.processFinished',
      })
      break
    }
    default:
      break
  }

  // Открытая вкладка объекта перечитывает маршрут
  emitToRoom(`object:${event.object.id}`, 'object.updated', {
    id: event.object.id,
    type: event.object.type,
    version: 0,
    changedFields: ['process'],
    actorId: event.actor.userId,
  })
}

async function activity(event: EventEnvelope): Promise<void> {
  const payload = event.payload as Record<string, unknown>
  switch (event.type) {
    case 'process.started':
      await recordModuleActivity(event, {
        verb: 'process_started',
        key: 'activity.process.started',
      })
      break
    case 'process.step_decided':
      await recordModuleActivity(event, {
        verb: `process_${String(payload.decision)}`,
        key: `activity.process.decided.${String(payload.decision)}`,
      })
      break
    case 'process.step_assignees_changed':
      await recordModuleActivity(event, {
        verb: `process_${String(payload.reason)}`,
        key: `activity.process.assignees.${String(payload.reason)}`,
      })
      break
    case 'process.finished':
      await recordModuleActivity(event, {
        verb: 'process_finished',
        key:
          payload.status === 'cancelled'
            ? 'activity.process.cancelled'
            : `activity.process.finished`,
      })
      break
    default:
      break
  }
}

/** Шаги `wait`, ждущие событие этого типа об объекте события. */
async function signal(event: EventEnvelope): Promise<void> {
  if (!event.object) return
  if (event.type === 'object.trashed') {
    await cancelForObject(event.object.id)
    return
  }
  const waiting = await db()
    .select({ stepId: processSteps.id, instanceId: processSteps.instanceId })
    .from(processSteps)
    .innerJoin(processInstances, eq(processInstances.id, processSteps.instanceId))
    .where(
      and(
        eq(processSteps.status, 'active'),
        eq(processSteps.waitEvent, event.type),
        eq(processInstances.objectId, event.object.id),
      ),
    )
  for (const row of waiting) {
    await db().transaction(async (tx) => {
      const loaded = await loadInstance(tx, row.instanceId, { lock: true })
      const run = loaded.state.steps.find((item) => item.id === row.stepId)
      if (run?.status !== 'active') return
      const step = loaded.def.steps[run.key]
      if (step?.type !== 'wait') return
      const execution = new Execution(tx, systemCtx('process.wait'), loaded)
      await execution.objectData()
      if (step.filter) {
        const data = { ...execution.evaluationData(), event }
        if (!evaluate(step.filter, data as unknown as Record<string, unknown>)) return
      }
      await execution.apply(
        transition(() =>
          completeStep(
            loaded.def,
            execution.state,
            { stepId: run.id, outcome: 'event', result: { eventId: event.id } },
            execution.env(),
          ),
        ),
      )
      await execution.commit()
    })
  }
}

/** Объект в корзине: идущие маршруты отменяются, дела во Входящих закрываются. */
async function cancelForObject(objectId: string): Promise<void> {
  const rows = await db()
    .select({ id: processInstances.id })
    .from(processInstances)
    .where(and(eq(processInstances.objectId, objectId), eq(processInstances.status, 'running')))
  for (const row of rows) {
    await db().transaction((tx) =>
      ProcessService.cancel(tx, systemCtx('process.object_trashed'), {
        instanceId: row.id,
        outcome: 'object_trashed',
      }),
    )
  }
}

/** Подписчики — в роли worker; список ожидаемых событий собран модулями при старте. */
export function processSubscribers(): Subscriber[] {
  return [
    { name: 'kernel-process-notifications', types: ['process.*'], handle: notify },
    {
      name: 'kernel-process-activity',
      types: [
        'process.started',
        'process.step_decided',
        'process.step_assignees_changed',
        'process.finished',
      ],
      handle: activity,
    },
    {
      name: 'kernel-process-signals',
      types: [...new Set([...waitableEvents(), 'object.trashed'])],
      handle: signal,
    },
  ]
}
