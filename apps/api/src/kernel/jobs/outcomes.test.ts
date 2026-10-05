import { describe, expect, it } from 'vitest'
import { closedReason, JOB_CANCELLED_REASON } from './outcomes.js'

describe('closedReason', () => {
  it('отмена — общая причина, сбой — текст задания или запасной', () => {
    expect(closedReason({ type: 'job.cancelled', payload: { jobId: 'x' } })).toBe(
      JOB_CANCELLED_REASON,
    )
    expect(closedReason({ type: 'job.failed', payload: { jobId: 'x', error: 'нет файла' } })).toBe(
      'нет файла',
    )
    expect(closedReason({ type: 'job.failed', payload: { jobId: 'x' } }, 'Сбой рендера')).toBe(
      'Сбой рендера',
    )
    expect(closedReason({ type: 'job.failed', payload: { jobId: 'x', error: '' } })).toBe(
      'Сбой задания',
    )
  })
})
