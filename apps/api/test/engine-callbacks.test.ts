import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  call,
  engineJobHeaders,
  registerLifecycle,
  setupFixture,
  type TestContext,
} from './helpers.js'

/**
 * Обратные вызовы движка (ADR-0176): api выдаёт токен заданию очереди движка при
 * передаче в BullMQ, токен открывает маршруты только своего задания и его
 * ресурса; общий сервисный токен (он есть у движка) внутренних маршрутов не
 * открывает.
 */
registerLifecycle()

const { JobService, queue } = await import('../src/kernel/jobs/service.js')
const { verifyJobToken } = await import('../src/shared/crypto/job-token.js')
const { systemCtx } = await import('../src/shared/context.js')
const { config } = await import('../src/shared/config/index.js')

let fx: TestContext
const run = Date.now().toString(36)
const queued: Array<{ queue: 'transform' | 'maintenance'; id: string }> = []

async function enqueue(
  name: 'transform' | 'maintenance',
  callbackScope?: string,
): Promise<{ id: string; data: Record<string, unknown> }> {
  const id = await JobService.enqueue(systemCtx('test'), {
    queue: name,
    name: name === 'transform' ? 'engine.echo' : 'test.echo',
    data: { message: run },
    ...(callbackScope ? { callbackScope } : {}),
  })
  expect(await JobService.dispatch(id)).toBe(true)
  queued.push({ queue: name, id })
  const job = await queue(name).getJob(id)
  return { id, data: (job?.data ?? {}) as Record<string, unknown> }
}

beforeAll(async () => {
  fx = await setupFixture()
})

afterAll(async () => {
  for (const item of queued) await (await queue(item.queue).getJob(item.id))?.remove()
})

describe('токен задания движка', () => {
  it('задание очереди движка получает токен своего ресурса, задание воркера — нет', async () => {
    const engine = await enqueue('transform', `file:${run}`)
    expect(verifyJobToken(engine.data.callbackToken)).toMatchObject({
      jobId: engine.id,
      scope: `file:${run}`,
    })
    const worker = await enqueue('maintenance')
    expect(worker.data.callbackToken).toBeUndefined()
  })

  it('маршрут статуса принимает только токен своего задания', async () => {
    const { id, data } = await enqueue('transform')
    const status = (headers: Record<string, string>) =>
      call(fx.app, {
        method: 'POST',
        url: `/internal/jobs/${id}/status`,
        payload: { status: 'running' },
        headers,
      })

    expect((await status({})).statusCode).toBe(401)
    const shared = { 'x-kchs-service-token': config().INTERNAL_SERVICE_TOKEN ?? '' }
    expect((await status(shared)).statusCode).toBe(401)
    expect((await status(engineJobHeaders({}))).statusCode).toBe(403)

    const own = await status({ 'x-kchs-job-token': String(data.callbackToken) })
    expect(own.statusCode, own.body).toBe(200)
    expect((await JobService.get(id))?.status).toBe('running')
  })

  it('токен без ресурса не открывает маршрут ресурса', async () => {
    const { id } = await enqueue('transform')
    const response = await call(fx.app, {
      method: 'POST',
      url: `/internal/files/${id}/processed`,
      payload: { versionId: id, previewStatus: 'ready', textStatus: 'ready' },
      headers: engineJobHeaders({ jobId: id }),
    })
    expect(response.statusCode).toBe(403)
  })
})
