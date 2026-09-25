import type { TaskPermissions, TaskStatus } from '@kchs/contracts'
import { describe, expect, it } from 'vitest'
import { boardMove, dateFromDue, dueFromDate } from './task-status.js'

const can = (transitions: TaskStatus[]): TaskPermissions => ({
  edit: false,
  start: false,
  report: false,
  accept: false,
  return: false,
  cancel: false,
  requestExtension: false,
  decideExtension: false,
  reassign: false,
  checklist: false,
  subtasks: false,
  transitions,
})

describe('перенос на доске', () => {
  it('задача: статус категории из переходов, иначе нельзя', () => {
    const task = { kind: 'task' as const, can: can(['in_progress', 'review', 'done', 'cancelled']) }
    expect(boardMove(task, 'review')).toEqual({ kind: 'status', status: 'review' })
    expect(boardMove(task, 'todo')).toBeNull()
  })

  it('поручение: колонка — действие; возврат с замечаниями — только из карточки', () => {
    const assignee = { kind: 'instruction' as const, can: can(['in_progress']) }
    expect(boardMove(assignee, 'in_progress')).toEqual({ kind: 'action', action: 'start' })
    const reporter = { kind: 'instruction' as const, can: can(['reported']) }
    expect(boardMove(reporter, 'review')).toEqual({ kind: 'action', action: 'report' })
    const author = { kind: 'instruction' as const, can: can(['accepted', 'returned', 'cancelled']) }
    expect(boardMove(author, 'done')).toEqual({ kind: 'action', action: 'accept' })
    expect(boardMove(author, 'in_progress')).toBeNull()
  })
})

describe('срок', () => {
  it('день ↔ конец дня по местным часам', () => {
    const due = dueFromDate('2026-09-21')
    expect(dateFromDue(due)).toBe('2026-09-21')
    expect(new Date(due).getHours()).toBe(23)
    expect(dateFromDue(null)).toBe('')
  })
})
