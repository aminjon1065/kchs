import { type RouteContract, splitRouteKey } from '@kchs/contracts'
import { routes } from '@kchs/process/routes'
import Fastify from 'fastify'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { assertRouteTableRegistered, registeredRoutes, routeRegistrar } from './route.js'

function app() {
  const instance = Fastify()
  instance.setValidatorCompiler(validatorCompiler)
  instance.setSerializerCompiler(serializerCompiler)
  return instance
}

describe('регистрация маршрутов по таблице контрактов (ADR-0188)', () => {
  it('маршрут вне таблицы не регистрируется', () => {
    const route = routeRegistrar(app())
    expect(() =>
      route({
        route: 'GET /no-such-route' as never,
        auth: 'session',
        handler: (async () => null) as never,
      }),
    ).toThrow(/GET \/no-such-route не описан в таблице маршрутов/)
  })

  it('метод, путь и схемы — из записи таблицы', async () => {
    const instance = app()
    routeRegistrar(instance)({
      route: 'GET /tasks/:id',
      auth: { delegated: 'тест', objectType: 'task' },
      handler: async (_request, reply) => reply.code(204).send(),
    })
    const registered = registeredRoutes().find((r) => r.method === 'GET' && r.url === '/tasks/:id')
    expect(registered?.schema?.params).toBe(routes['GET /tasks/:id'].params)
    expect(registered?.schema?.response).toBe(routes['GET /tasks/:id'].response)
    // Параметры проверяет схема таблицы
    const response = await instance.inject({ method: 'GET', url: '/tasks/не-uuid' })
    expect(response.statusCode).toBe(400)
  })

  it('ответ обработчика сверяется со схемой ответа маршрута — и в typecheck, и при отправке', async () => {
    const instance = app()
    const route = routeRegistrar(instance)
    route({
      route: 'DELETE /gis/basemaps/:id',
      auth: { delegated: 'тест', objectType: 'basemap' },
      // @ts-expect-error — схема ответа { ok: boolean }: обработчик вернул другое (шаг 3 ADR-0188)
      handler: async () => ({ deleted: true }),
    })
    route({
      route: 'POST /gis/basemaps/:id/default',
      auth: { delegated: 'тест', objectType: 'basemap' },
      // @ts-expect-error — поле есть, но не того типа
      handler: async () => ({ ok: 'да' }),
    })
    const id = '00000000-0000-4000-8000-000000000001'
    // Без проверки типов то же расхождение ловит только сериализатор — ответом 500
    const response = await instance.inject({ method: 'DELETE', url: `/gis/basemaps/${id}` })
    expect(response.statusCode).toBe(500)
  })

  it('запись таблицы без регистрации не доживает до запуска', () => {
    expect(() => assertRouteTableRegistered()).toThrow(/не зарегистрированы: .*GET \/tasks,/)
  })

  it('схема параметров пути называет ровно параметры пути', () => {
    const problems: string[] = []
    for (const [key, contract] of Object.entries(routes) as Array<[string, RouteContract]>) {
      const params: unknown = contract.params
      if (!(params instanceof z.ZodObject)) continue
      const inPath = [...splitRouteKey(key).url.matchAll(/:([A-Za-z_]\w*)/g)].map((m) => m[1])
      const inSchema = Object.keys(params.shape)
      if ([...inPath].sort().join() !== [...inSchema].sort().join()) problems.push(key)
    }
    expect(problems).toEqual([])
  })
})
