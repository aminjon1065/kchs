import { type RouteContract, splitRouteKey } from '@kchs/contracts'
import { describe, expect, it } from 'vitest'
import { openApiSchemaTransforms } from './openapi-schemas.js'
import { routeTable } from './route-table.js'

const openapiObject = { openapi: '3.1.0' }
const PREFIX = '#/components/schemas/'

describe('схемы спецификации OpenAPI (ADR-0188)', () => {
  it('ссылки схем маршрутов ведут на описанные компоненты', () => {
    const { transform, transformObject } = openApiSchemaTransforms()
    const document = transformObject({ openapiObject } as never) as {
      components?: { schemas?: Record<string, Record<string, unknown>> }
    }
    const components = document.components?.schemas ?? {}
    expect(Object.keys(components).sort()).toEqual([
      'FilterNode',
      'FilterNodeInput',
      'Json',
      'JsonInput',
      'RuleCondition',
      'RuleConditionInput',
    ])
    // Служебные следы zod у компонента не остаются
    for (const schema of Object.values(components)) {
      expect(schema).not.toHaveProperty('$id')
      expect(schema).not.toHaveProperty('$schema')
    }

    const dangling = new Set<string>()
    let refs = 0
    for (const [key, contract] of Object.entries(routeTable) as Array<[string, RouteContract]>) {
      const schema = {
        params: contract.params,
        querystring: contract.query,
        body: contract.body,
        response: contract.response,
      }
      const out = transform({ schema, url: splitRouteKey(key).url, openapiObject } as never)
      for (const match of JSON.stringify(out).matchAll(/"\$ref":"([^"]*)"/g)) {
        const ref = match[1] ?? ''
        refs += 1
        if (!(ref.startsWith(PREFIX) && ref.slice(PREFIX.length) in components)) {
          dangling.add(`${key}: ${ref}`)
        }
      }
    }
    expect([...dangling]).toEqual([])
    expect(refs).toBeGreaterThan(0)
  })
})
