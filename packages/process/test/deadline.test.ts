import { describe, expect, it } from 'vitest'
import {
  deadlineOf,
  hoursDeadline,
  hoursReminder,
  ProcessDefinition,
  type StepOf,
  validateDefinition,
  waitDurationOf,
} from '../src/index.js'

/**
 * Сроки шагов в календарных часах (ADR-0131): схема, одно из двух полей срока,
 * момент срока без производственного календаря и напоминание незадолго до срока.
 */
type Input = Record<string, unknown>

function route(steps: Record<string, unknown>, extra: Input = {}): Input {
  return {
    version: 1,
    key: 'urgent_report',
    objectType: 'document',
    name: { ru: 'Экстренное донесение' },
    start: Object.keys(steps)[0],
    steps,
    ...extra,
  }
}

function errors(input: Input): string[] {
  return validateDefinition(input)
    .issues.filter((issue) => issue.severity === 'error')
    .map((issue) => `${issue.code} ${issue.path}`)
}

describe('схема: срок в часах', () => {
  it('шаги с решением, задача, возврат и ожидание принимают часы', () => {
    const def = ProcessDefinition.parse(
      route({
        review: { type: 'approval', assignees: ['author'], dueHours: 2, next: 'sign' },
        sign: { type: 'sign', assignees: ['author'], dueHours: 4, next: 'reg' },
        reg: { type: 'register', assignees: ['role:registrar'], dueHours: 1, next: 'ack' },
        ack: { type: 'acknowledge', assignees: ['author'], dueHours: 24, next: 'job' },
        job: {
          type: 'task',
          title: { ru: 'Выезд' },
          assignees: ['author'],
          dueHours: 3,
          next: 'hold',
        },
        hold: { type: 'wait', durationHours: 6, next: 'end' },
        back: { type: 'return', dueHours: 12, next: 'review' },
        end: { type: 'end' },
      }),
    )
    expect(deadlineOf(def.steps.review as never)).toEqual({ unit: 'hours', value: 2 })
    expect(deadlineOf(def.steps.back as never)).toEqual({ unit: 'hours', value: 12 })
    expect(waitDurationOf(def.steps.hold as StepOf<'wait'>)).toEqual({ unit: 'hours', value: 6 })
  })

  it.each([
    ['ноль часов', 0],
    ['больше 30 суток', 721],
    ['дробные часы', 1.5],
  ])('схема отклоняет: %s', (_, dueHours) => {
    const input = route({
      review: { type: 'approval', assignees: ['author'], dueHours, next: 'end' },
      end: { type: 'end' },
    })
    expect(ProcessDefinition.safeParse(input).success).toBe(false)
  })

  it('у шагов без срока поля часов нет', () => {
    const input = route({
      tell: { type: 'notify', to: 'author', dueHours: 2, next: 'end' },
      end: { type: 'end' },
    })
    expect(ProcessDefinition.safeParse(input).success).toBe(false)
  })

  it('срок в рабочих днях читается прежним образом', () => {
    const def = ProcessDefinition.parse(
      route({
        review: { type: 'approval', assignees: ['author'], dueWorkingDays: 3, next: 'hold' },
        hold: { type: 'wait', durationWorkingDays: 2, next: 'end' },
        end: { type: 'end' },
      }),
    )
    expect(deadlineOf(def.steps.review as never)).toEqual({ unit: 'working_days', value: 3 })
    expect(waitDurationOf(def.steps.hold as StepOf<'wait'>)).toEqual({
      unit: 'working_days',
      value: 2,
    })
    expect(deadlineOf(def.steps.end as never)).toBeUndefined()
  })
})

describe('проверка: срок одним способом', () => {
  it('дни и часы сразу — ошибка due_conflict у шага, ожидания и вставляемого шага', () => {
    const input = route(
      {
        review: {
          type: 'approval',
          assignees: ['author'],
          dueWorkingDays: 1,
          dueHours: 2,
          next: 'hold',
        },
        hold: { type: 'wait', durationWorkingDays: 1, durationHours: 3, next: 'end' },
        end: { type: 'end' },
      },
      {
        conditions: [
          {
            if: 'true',
            insertBefore: 'review',
            step: { type: 'sign', assignees: ['author'], dueWorkingDays: 1, dueHours: 1 },
          },
        ],
      },
    )
    expect(errors(input)).toEqual(
      expect.arrayContaining([
        'due_conflict steps.review.dueHours',
        'due_conflict steps.hold.durationHours',
        'due_conflict conditions.0.step.dueHours',
      ]),
    )
  })

  it('ожидание только с часами — не пустое', () => {
    const input = route({
      hold: { type: 'wait', durationHours: 2, next: 'end' },
      end: { type: 'end' },
    })
    expect(errors(input)).toEqual([])
  })

  it('экстренный маршрут в часах проходит проверку', () => {
    const input = route(
      {
        review: {
          type: 'approval',
          mode: 'parallel',
          assignees: ['unit_head(author.unit)'],
          dueHours: 2,
          next: 'sign',
        },
        sign: { type: 'sign', assignees: ['author'], dueHours: 1, next: 'end' },
        end: { type: 'end' },
      },
      { timers: [{ step: '*', onOverdue: [{ action: 'notify', to: 'manager(step.assignee)' }] }] },
    )
    expect(errors(input)).toEqual([])
  })
})

describe('момент срока и напоминание', () => {
  const activated = '2026-09-26T22:30:00.000Z'

  it('срок — ровно через N календарных часов, в выходной тоже', () => {
    // 26.09.2026 — суббота: рабочий календарь не сдвигает часовой срок
    expect(hoursDeadline(activated, 4).toISOString()).toBe('2026-09-27T02:30:00.000Z')
    expect(hoursDeadline(new Date(activated), 48).toISOString()).toBe('2026-09-28T22:30:00.000Z')
  })

  it('напоминание за час до срока, если на шаг не меньше двух часов', () => {
    expect(hoursReminder(activated, hoursDeadline(activated, 4)).toISOString()).toBe(
      '2026-09-27T01:30:00.000Z',
    )
    expect(hoursReminder(activated, hoursDeadline(activated, 2)).toISOString()).toBe(
      '2026-09-26T23:30:00.000Z',
    )
  })

  it('у срока короче двух часов напоминание посередине', () => {
    expect(hoursReminder(activated, hoursDeadline(activated, 1)).toISOString()).toBe(
      '2026-09-26T23:00:00.000Z',
    )
  })
})
