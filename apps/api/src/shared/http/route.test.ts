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
      route({ route: 'GET /no-such-route' as never, auth: 'session', handler: async () => null }),
    ).toThrow(/GET \/no-such-route не описан в таблице маршрутов/)
  })

  it('метод, путь и схемы — из записи таблицы', async () => {
    const instance = app()
    routeRegistrar(instance)({
      route: 'GET /tasks/:id',
      auth: { delegated: 'тест', objectType: 'task' },
      handler: async (request) => ({ id: request.params.id }),
    })
    const registered = registeredRoutes().find((r) => r.method === 'GET' && r.url === '/tasks/:id')
    expect(registered?.schema?.params).toBe(routes['GET /tasks/:id'].params)
    expect(registered?.schema?.response).toBe(routes['GET /tasks/:id'].response)
    // Параметры проверяет схема таблицы
    const response = await instance.inject({ method: 'GET', url: '/tasks/не-uuid' })
    expect(response.statusCode).toBe(400)
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
