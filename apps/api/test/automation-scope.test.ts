import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { registerLifecycle, setupFixture, type TestContext } from './helpers.js'

/**
 * Область вычисления запуска правила (ADR-0222): имя инициатора читается из справочника
 * одним обращением на запуск, а не двумя.
 */
registerLifecycle()

const { buildScopeData } = await import('../src/modules/automation/domain/runner.js')
const { directory } = await import('../src/kernel/directory/port.js')

let fx: TestContext

beforeAll(async () => {
  fx = await setupFixture()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('область запуска правила', () => {
  it('имя инициатора — одним обращением к справочнику', async () => {
    const refs = vi.spyOn(directory(), 'refs')
    const data = await buildScopeData({ actorId: fx.admin.id }, null)
    expect(refs).toHaveBeenCalledTimes(1)
    const [expected] = (await directory().refs([fx.admin.id])).values()
    expect(data.actor.displayName).toBe(expected?.displayName)
    expect(data.actor.displayName).toBeTruthy()
  })

  it('неизвестный инициатор — без имени', async () => {
    const data = await buildScopeData({ actorId: '00000000-0000-7000-8000-000000000000' }, null)
    expect(data.actor.displayName).toBeNull()
  })
})
