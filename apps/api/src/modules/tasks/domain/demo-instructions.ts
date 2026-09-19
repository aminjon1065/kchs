import { TaskCreateInput } from '@kchs/contracts'
import { buildUserCtxFor } from '~/kernel/access/explain.js'
import { addDays, endOfLocalDay, localDate } from '~/kernel/business-calendar/working-days.js'
import { config } from '~/shared/config/index.js'
import type { UserCtx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { TaskService } from './task-service.js'

/** Руководитель и его подчинённые — команда для демо-поручений. */
export interface DemoTeam {
  headId: string
  memberIds: readonly string[]
}

const TITLES = [
  'Подготовить сводку паводковой обстановки',
  'Обновить реестр защитных сооружений',
  'Проверить готовность сил и средств',
  'Сверить графики дежурных смен',
  'Подготовить справку о ходе учений',
  'Актуализировать план эвакуации',
  'Провести инвентаризацию техники',
  'Сверить данные мониторинга с районами',
  'Подготовить предложения в план на квартал',
  'Обновить паспорт территории района',
  'Проверить исправность средств оповещения',
  'Подготовить отчёт о прошедших паводках',
] as const

/** Состояния контроля, которые покрывают демо-поручения. */
const SCENARIOS = [
  'on_track',
  'overdue',
  'extended',
  'done_on_time',
  'due_today',
  'done_late',
  'parts',
] as const
type Scenario = (typeof SCENARIOS)[number]

/**
 * Демо-поручения (seed, профиль demo; ADR-0082): руководители подразделений
 * поручают подчинённым; состояния — в срок, срок сегодня, просрочено, продлено,
 * исполнено в срок и с опозданием, части соисполнителей. Всё — действиями
 * участников через службу задач, как в интерфейсе: «Контроль», «Нагрузка» и
 * «Мой день» демо-стенда не пустые.
 */
export async function seedDemoInstructions(
  teams: readonly DemoTeam[],
  perTeam = 3,
): Promise<number> {
  const timezone = config().TZ
  const today = localDate(new Date(), timezone)
  const endOf = (offset: number) => endOfLocalDay(addDays(today, offset), timezone).toISOString()
  const contexts = new Map<string, UserCtx>()
  const ctxOf = async (userId: string): Promise<UserCtx> => {
    const cached = contexts.get(userId)
    if (cached) return cached
    const ctx = await buildUserCtxFor(userId)
    if (!ctx) throw new Error(`демо-поручения: нет сотрудника ${userId}`)
    contexts.set(userId, ctx)
    return ctx
  }

  let created = 0
  let index = 0
  for (const team of teams) {
    if (team.memberIds.length === 0) continue
    const author = await ctxOf(team.headId)
    for (let slot = 0; slot < perTeam; slot++, index++) {
      const scenario: Scenario = SCENARIOS[index % SCENARIOS.length] as Scenario
      const assigneeId = team.memberIds[index % team.memberIds.length] as string
      const coAssignees =
        scenario === 'parts' ? team.memberIds.filter((id) => id !== assigneeId).slice(0, 2) : []
      const title = TITLES[index % TITLES.length] as string
      const workingDays = 3 + (index % 12)
      const due =
        scenario === 'overdue'
          ? { dueAt: endOf(-2 - (index % 9)) }
          : scenario === 'done_late'
            ? { dueAt: endOf(-3 - (index % 20)) }
            : scenario === 'due_today'
              ? { dueAt: endOf(0) }
              : { dueWorkingDays: workingDays }
      const input = TaskCreateInput.parse({
        kind: 'instruction',
        title,
        description: 'Демонстрационное поручение: создано при загрузке демо-данных.',
        assigneeId,
        coAssigneeIds: coAssignees,
        priority: 1 + (index % 4),
        ...due,
      })
      const id = await db().transaction((tx) => TaskService.create(tx, author, input))
      created += 1
      const assignee = await ctxOf(assigneeId)
      if (scenario === 'on_track' && index % 2 === 0) continue
      if (scenario === 'due_today' || scenario === 'parts') continue
      await db().transaction((tx) => TaskService.start(tx, assignee, id))
      if (scenario === 'extended') {
        await db().transaction((tx) =>
          TaskService.requestExtension(tx, assignee, id, {
            dueWorkingDays: workingDays + 5,
            reason: 'Нужны сведения от районов, запрошены дополнительно.',
          }),
        )
        await db().transaction((tx) =>
          TaskService.decideExtension(tx, author, id, { decision: 'approve' }),
        )
      }
      if (scenario === 'done_on_time' || scenario === 'done_late') {
        await db().transaction((tx) =>
          TaskService.report(tx, assignee, id, {
            text: 'Исполнено: материалы подготовлены и размещены в пространстве подразделения.',
            objectIds: [],
          }),
        )
        await db().transaction((tx) => TaskService.accept(tx, author, id))
      }
    }
  }
  return created
}
