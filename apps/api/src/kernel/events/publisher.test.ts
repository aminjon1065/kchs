import { EVENT_VERSIONS } from '@kchs/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { systemCtx } from '~/shared/context.js'
import { buildEnvelope } from './publisher.js'

describe('конверт события', () => {
  afterEach(() => {
    delete EVENT_VERSIONS['task.accepted']
  })

  it('версия нагрузки — из каталога, по умолчанию 1 (ADR-0189)', () => {
    const ctx = systemCtx('test')
    const input = { type: 'task.accepted', payload: { key: 'T-1' } }
    expect(buildEnvelope(ctx, input).version).toBe(1)

    EVENT_VERSIONS['task.accepted'] = 2
    expect(buildEnvelope(ctx, input).version).toBe(2)
    // Явная версия публикации важнее каталога
    expect(buildEnvelope(ctx, { ...input, version: 3 }).version).toBe(3)
  })
})
