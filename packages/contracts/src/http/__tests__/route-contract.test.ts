import { describe, expect, expectTypeOf, it } from 'vitest'
import { z } from 'zod'
import { apiRoutes } from '../../routes/index.js'
import {
  defineRoutes,
  mergeRouteTables,
  type PathParamNames,
  type RouteBody,
  type RouteKey,
  type RouteMethod,
  type RouteParams,
  type RoutePath,
  type RouteQuery,
  type RouteResponse,
  splitRouteKey,
} from '../route-contract.js'

const table = defineRoutes({
  'GET /items/:id': {
    params: z.object({ id: z.uuid() }),
    response: { 200: z.object({ id: z.uuid(), size: z.number() }) },
  },
  'GET /items': { query: z.object({ q: z.string().optional() }) },
  'POST /items/:id/files/:fileId': {
    body: z.object({ name: z.string(), note: z.string().default('') }),
    response: { 201: z.object({ ok: z.boolean() }), 404: z.object({ title: z.string() }) },
  },
})
type Table = typeof table

describe('таблица маршрутов (ADR-0188)', () => {
  it('ключ — метод и путь в синтаксисе Fastify', () => {
    expect(() => defineRoutes({ 'GET items': {} } as never)).toThrow(/МЕТОД \/путь/)
    expect(() => defineRoutes({ 'FETCH /items': {} } as never)).toThrow(/МЕТОД \/путь/)
    expect(splitRouteKey('PATCH /tasks/:id')).toEqual({ method: 'PATCH', url: '/tasks/:id' })
    expect(() => splitRouteKey('/tasks')).toThrow(/МЕТОД \/путь/)
  })

  it('маршрут, описанный в двух таблицах, — ошибка', () => {
    const other = defineRoutes({ 'GET /items': {} })
    expect(() => mergeRouteTables(table, other)).toThrow(/GET \/items описан в двух таблицах/)
    expect(Object.keys(mergeRouteTables(table, defineRoutes({ 'GET /other': {} })))).toHaveLength(4)
  })

  it('схема параметров пути называет ровно параметры пути', () => {
    const problems: string[] = []
    for (const [key, contract] of Object.entries(apiRoutes) as Array<
      [RouteKey, { params?: unknown }]
    >) {
      if (!(contract.params instanceof z.ZodObject)) continue
      const inPath = [...splitRouteKey(key).url.matchAll(/:([A-Za-z_]\w*)/g)].map((m) => m[1])
      const inSchema = Object.keys(contract.params.shape)
      if ([...inPath].sort().join() !== [...inSchema].sort().join()) {
        problems.push(`${key}: в пути ${inPath.join(', ')}, в схеме ${inSchema.join(', ')}`)
      }
    }
    expect(problems).toEqual([])
  })

  it('по ключу выводятся путь, параметры, строка запроса, тело и ответ', () => {
    expectTypeOf<RoutePath<'GET /items/:id'>>().toEqualTypeOf<'/items/:id'>()
    expectTypeOf<RouteMethod<'POST /items/:id/files/:fileId'>>().toEqualTypeOf<'POST'>()
    expectTypeOf<PathParamNames<'/items/:id/files/:fileId'>>().toEqualTypeOf<'id' | 'fileId'>()

    // Параметры: по схеме, а без схемы — по сегментам пути; без параметров — нет
    expectTypeOf<RouteParams<Table['GET /items/:id'], 'GET /items/:id'>>().toEqualTypeOf<{
      id: string
    }>()
    expectTypeOf<
      RouteParams<Table['POST /items/:id/files/:fileId'], 'POST /items/:id/files/:fileId'>
    >().toEqualTypeOf<{ id: string; fileId: string }>()
    expectTypeOf<RouteParams<Table['GET /items'], 'GET /items'>>().toEqualTypeOf<undefined>()

    // Строка запроса и тело — то, что передаёт клиент (вход схемы)
    expectTypeOf<RouteQuery<Table['GET /items']>>().toEqualTypeOf<{ q?: string | undefined }>()
    expectTypeOf<RouteQuery<Table['GET /items/:id']>>().toEqualTypeOf<undefined>()
    expectTypeOf<RouteBody<Table['POST /items/:id/files/:fileId']>>().toEqualTypeOf<{
      name: string
      note?: string | undefined
    }>()

    // Ответ — успешный код после разбора; без схемы — неизвестен
    expectTypeOf<RouteResponse<Table['GET /items/:id']>>().toEqualTypeOf<{
      id: string
      size: number
    }>()
    expectTypeOf<RouteResponse<Table['POST /items/:id/files/:fileId']>>().toEqualTypeOf<{
      ok: boolean
    }>()
    expectTypeOf<RouteResponse<Table['GET /items']>>().toEqualTypeOf<unknown>()
  })
})
