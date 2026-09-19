import type { TaskStatus } from '@kchs/contracts'
import { describe, expect, it } from 'vitest'
import { extensionDecider, isOverdue, permissionsFor, type TaskFacts } from './task-rules.js'

const AUTHOR = 'author'
const ASSIGNEE = 'assignee'
const CONTROLLER = 'controller'
const DEPUTY = 'deputy'

const instruction = (status: TaskStatus, extra: Partial<TaskFacts> = {}): TaskFacts => ({
  kind: 'instruction',
  status,
  authorId: AUTHOR,
  assigneeId: ASSIGNEE,
  coAssignees: ['co'],
  controllerId: CONTROLLER,
  ...extra,
})

describe('права поручения в полном режиме (ADR-0082)', () => {
  it('исполнитель принимает, отчитывается и просит продления — пока работает', () => {
    const can = permissionsFor(instruction('in_progress'), { userId: ASSIGNEE }, 'edit')
    expect(can).toMatchObject({
      report: true,
      requestExtension: true,
      reassign: false,
      edit: false,
    })
    // Запрос уже ждёт решения — второй нельзя
    expect(
      permissionsFor(
        instruction('in_progress', { pendingExtension: true }),
        { userId: ASSIGNEE },
        'edit',
      ).requestExtension,
    ).toBe(false)
    // После отчёта продление не просят
    expect(
      permissionsFor(instruction('reported'), { userId: ASSIGNEE }, 'edit').requestExtension,
    ).toBe(false)
  })

  it('решает по продлению автор; нет автора — контролёр; исполнитель — нет', () => {
    const pending = instruction('assigned', { pendingExtension: true })
    expect(permissionsFor(pending, { userId: AUTHOR }, 'owner').decideExtension).toBe(true)
    expect(permissionsFor(pending, { userId: CONTROLLER }, 'edit').decideExtension).toBe(false)
    expect(permissionsFor(pending, { userId: ASSIGNEE }, 'edit').decideExtension).toBe(false)
    const orphan = instruction('assigned', { pendingExtension: true, authorId: null })
    expect(extensionDecider(orphan)).toBe(CONTROLLER)
    expect(permissionsFor(orphan, { userId: CONTROLLER }, 'edit').decideExtension).toBe(true)
    // Без запроса решать нечего
    expect(
      permissionsFor(instruction('assigned'), { userId: AUTHOR }, 'owner').decideExtension,
    ).toBe(false)
  })

  it('переназначает автор или контролёр — до отчёта', () => {
    for (const status of ['assigned', 'in_progress', 'returned'] as const) {
      expect(permissionsFor(instruction(status), { userId: AUTHOR }, 'owner').reassign).toBe(true)
      expect(permissionsFor(instruction(status), { userId: CONTROLLER }, 'edit').reassign).toBe(
        true,
      )
      expect(permissionsFor(instruction(status), { userId: ASSIGNEE }, 'edit').reassign).toBe(false)
    }
    expect(permissionsFor(instruction('reported'), { userId: AUTHOR }, 'owner').reassign).toBe(
      false,
    )
    expect(permissionsFor(instruction('accepted'), { userId: AUTHOR }, 'owner').reassign).toBe(
      false,
    )
    // Руководитель исполнителя только смотрит
    expect(permissionsFor(instruction('assigned'), { userId: 'manager' }, 'view')).toMatchObject({
      reassign: false,
      accept: false,
      edit: false,
    })
  })

  it('заместитель действует ролями замещаемого', () => {
    const can = permissionsFor(
      instruction('assigned', { pendingExtension: true }),
      { userId: DEPUTY, onBehalfOf: AUTHOR },
      'edit',
    )
    expect(can).toMatchObject({ decideExtension: true, reassign: true, cancel: true })
    const executor = permissionsFor(
      instruction('assigned'),
      { userId: DEPUTY, onBehalfOf: ASSIGNEE },
      'edit',
    )
    expect(executor).toMatchObject({ start: true, requestExtension: true, reassign: false })
  })

  it('у обычной задачи действий поручения нет', () => {
    const can = permissionsFor(
      { ...instruction('todo'), kind: 'task', pendingExtension: true },
      { userId: AUTHOR },
      'owner',
    )
    expect(can).toMatchObject({ requestExtension: false, decideExtension: false, reassign: false })
  })
})

describe('просрочка', () => {
  const due = '2026-10-07T18:59:59.999Z'
  const later = new Date('2026-10-08T05:00:00Z')

  it('срок прошёл, поручение открыто — просрочено; закрытое — нет', () => {
    expect(isOverdue('in_progress', due, later)).toBe(true)
    expect(isOverdue('accepted', due, later)).toBe(false)
    expect(isOverdue('in_progress', null, later)).toBe(false)
  })

  it('отчёт сдан до срока и ждёт приёмки — не просрочка; после срока — просрочка', () => {
    expect(isOverdue('reported', due, later, '2026-10-07T10:00:00Z')).toBe(false)
    expect(isOverdue('reported', due, later, '2026-10-08T04:00:00Z')).toBe(true)
  })
})
