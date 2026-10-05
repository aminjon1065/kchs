import { ENGINE_CALLBACKS } from '@kchs/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
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
const { registeredRoutes } = await import('../src/shared/http/route.js')

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

/**
 * Контракт движка (ADR-0190): маршрут обратного вызова принимает и отдаёт ровно
 * схемы `ENGINE_CALLBACKS` — по ним же движок сверяет свои модели, а api
 * проверяет нагрузку задания движка до записи в реестр.
 */
describe('контракт обратных вызовов и заданий движка', () => {
  const jsonSchema = (schema: unknown, io: 'input' | 'output') =>
    schema ? z.toJSONSchema(schema as z.ZodType, { io }) : null

  it('маршрут каждого обратного вызова — со схемами контракта', () => {
    const routes = new Map(
      registeredRoutes().map((route) => [`${route.method} ${route.url}`, route]),
    )
    for (const [name, callback] of Object.entries(ENGINE_CALLBACKS)) {
      const route = routes.get(`${callback.method} ${callback.path}`)
      expect(route, name).toBeDefined()
      expect(typeof route?.auth === 'object' && 'engineJob' in route.auth, name).toBe(true)
      expect(jsonSchema(route?.schema?.body, 'input'), name).toEqual(
        jsonSchema(callback.body, 'input'),
      )
      expect(jsonSchema(route?.schema?.response?.[200], 'output'), name).toEqual(
        jsonSchema(callback.reply, 'output'),
      )
    }
  })

  it('других внутренних маршрутов с токеном задания нет', () => {
    const declared = new Set(
      Object.values(ENGINE_CALLBACKS).map((callback) => `${callback.method} ${callback.path}`),
    )
    const engineRoutes = registeredRoutes().filter(
      (route) => typeof route.auth === 'object' && 'engineJob' in route.auth,
    )
    expect(engineRoutes.map((route) => `${route.method} ${route.url}`).sort()).toEqual(
      [...declared].sort(),
    )
  })

  it('нагрузку задания движка проверяет схема до записи в реестр', async () => {
    await expect(
      JobService.enqueue(systemCtx('test'), {
        queue: 'transform',
        name: 'engine.echo',
        data: { text: run },
      }),
    ).rejects.toThrow(/transform:engine\.echo не соответствует контракту: message/)

    const id = await JobService.enqueue(systemCtx('test'), {
      queue: 'transform',
      name: 'engine.echo',
      data: { message: run, extra: 'не из контракта' },
    })
    // В реестр попадает разобранная нагрузка: лишнего поля нет
    expect(await JobService.payload(id)).toEqual({ message: run })
  })
})
