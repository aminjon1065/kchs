import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Subscriber } from '../src/kernel/events/types.js'
import {
  call,
  createUser,
  registerLifecycle,
  setupFixture,
  signIn,
  type TestContext,
} from './helpers.js'

/**
 * Наследование прав и поисковый индекс (03-access-model.md §Наследование):
 * фильтр прав потомков зависит от предков, поэтому изменение доступа папки
 * переиндексирует поддерево заданием — с настоящими шиной событий и воркером.
 */
registerLifecycle()

const bus = await import('../src/kernel/events/index.js')
const { registerKernelSubscribers } = await import('../src/kernel/subscribers.js')
const { registerMaintenanceJobs } = await import('../src/kernel/jobs/maintenance.js')
const { startWorkers, stopWorkers } = await import('../src/kernel/jobs/runner.js')
const { indexObject } = await import('../src/kernel/search/index-service.js')

let fx: TestContext
let previousSubscribers: Subscriber[] = []
const run = Date.now().toString(36)

beforeAll(async () => {
  fx = await setupFixture()
  previousSubscribers = [...bus.listSubscribers()]
  bus.clearSubscribers()
  registerKernelSubscribers()
  registerMaintenanceJobs()
  startWorkers()
  bus.startConsumers({ blockMs: 100, retryIdleMs: 300, claimIntervalMs: 100 })
  bus.startDispatcher()
})

afterAll(async () => {
  bus.stopDispatcher()
  await bus.stopConsumers()
  await stopWorkers()
  bus.clearSubscribers()
  for (const subscriber of previousSubscribers) bus.registerSubscriber(subscriber)
})

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error('условие не выполнилось за отведённое время')
}

async function createFolder(name: string, parentId?: string): Promise<string> {
  const response = await call(fx.app, {
    method: 'POST',
    url: '/folders',
    as: fx.admin,
    payload: { name, spaceId: fx.spaceId, ...(parentId ? { parentId } : {}) },
  })
  expect(response.statusCode).toBe(200)
  return response.json().id as string
}

describe('поиск и граница наследования', () => {
  it('после разрыва наследования содержимое папки пропадает из поиска участника', async () => {
    const folder = await createFolder(`Разрыв поиск ${run}`)
    const title = `Отчёт оползни ${run}`
    const inner = await createFolder(title, folder)
    const newcomer = await createUser(fx.app, `search_newcomer_${run}`)
    await call(fx.app, {
      method: 'POST',
      url: `/spaces/${fx.spaceId}/members`,
      as: fx.admin,
      payload: { userId: newcomer.id, role: 'viewer' },
    })
    const fresh = await signIn(fx.app, newcomer.login, newcomer.id)
    const found = async () =>
      (
        (await call(fx.app, { url: `/search?q=${encodeURIComponent(title)}`, as: fresh })).json()
          .hits as Array<{ objectId: string }>
      ).map((hit) => hit.objectId)

    await indexObject(inner)
    await waitFor(async () => (await found()).includes(inner))

    // Разрыв копирует права текущих участников явно; снятие записи новичка
    // закрывает ему папку — и её содержимое в индексе после переиндексации поддерева
    await call(fx.app, {
      method: 'PUT',
      url: `/objects/${folder}/access-mode`,
      as: fx.admin,
      payload: { mode: 'restricted' },
    })
    const revoked = await call(fx.app, {
      method: 'DELETE',
      url: `/objects/${folder}/access`,
      as: fx.admin,
      payload: { principal: { type: 'user', id: newcomer.id } },
    })
    expect(revoked.statusCode).toBe(200)

    await waitFor(async () => !(await found()).includes(inner))
    expect((await call(fx.app, { url: `/objects/${inner}`, as: fresh })).statusCode).toBe(404)
  })
})
