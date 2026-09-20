import type { FastifyInstance } from 'fastify'
import { beforeAll, describe, expect, it } from 'vitest'
import { bootTestApp, call, registerLifecycle } from './helpers.js'

/**
 * Публичная документация API и полнота OpenAPI (P5-E02, ADR-0097).
 * Спецификация — контракт для интеграций: у каждой операции должны быть тег,
 * краткое описание и ответы, иначе документация врёт, а область доступа токена
 * (она выводится из тега) перестаёт определяться.
 */
registerLifecycle()

let app: FastifyInstance
let spec: {
  openapi: string
  info: { title: string; description?: string }
  tags?: Array<{ name: string }>
  security?: unknown
  components?: { securitySchemes?: Record<string, unknown> }
  paths: Record<string, Record<string, Operation>>
}

interface Operation {
  summary?: string
  tags?: string[]
  responses?: Record<string, unknown>
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete']

beforeAll(async () => {
  app = await bootTestApp()
  const response = await app.inject({ method: 'GET', url: '/api/openapi.json' })
  expect(response.statusCode).toBe(200)
  spec = response.json()
})

function operations(): Array<{ path: string; method: string; operation: Operation }> {
  const list: Array<{ path: string; method: string; operation: Operation }> = []
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of METHODS) {
      const operation = item[method]
      if (operation) list.push({ path, method, operation })
    }
  }
  return list
}

describe('OpenAPI', () => {
  it('описывает обе схемы аутентификации и объявляет их по умолчанию', () => {
    expect(spec.openapi.startsWith('3.1')).toBe(true)
    expect(Object.keys(spec.components?.securitySchemes ?? {})).toEqual(
      expect.arrayContaining(['cookieAuth', 'bearerAuth']),
    )
    expect(spec.security).toEqual([{ cookieAuth: [] }, { bearerAuth: [] }])
    expect(spec.info.description).toContain('Bearer')
  })

  it('у каждой операции есть тег, краткое описание и ответы', () => {
    const problems: string[] = []
    for (const { path, method, operation } of operations()) {
      const where = `${method.toUpperCase()} ${path}`
      if (!operation.tags?.length) problems.push(`${where}: нет тега`)
      if (!operation.summary) problems.push(`${where}: нет краткого описания`)
      if (!operation.responses || Object.keys(operation.responses).length === 0) {
        problems.push(`${where}: нет ответов`)
      }
    }
    expect(problems).toEqual([])
  })

  it('каждый использованный тег описан в разделах спецификации', () => {
    const declared = new Set((spec.tags ?? []).map((tag) => tag.name))
    const used = new Set(operations().flatMap(({ operation }) => operation.tags ?? []))
    expect([...used].filter((tag) => !declared.has(tag))).toEqual([])
  })

  it('содержит массовые операции и точку входящего вебхука', () => {
    expect(spec.paths['/objects/batch-get']?.post).toBeDefined()
    expect(spec.paths['/datasets/{id}/rows/batch']?.post).toBeDefined()
    expect(spec.paths['/hooks/{integrationId}/{secret}']?.post).toBeDefined()
    expect(spec.paths['/me/api-tokens']?.post).toBeDefined()
    expect(spec.paths['/webhooks']?.post).toBeDefined()
  })

  it('длительная операция описана ответом 202 с идентификатором задания', () => {
    const batch = spec.paths['/datasets/{id}/rows/batch']?.post
    expect(Object.keys(batch?.responses ?? {})).toEqual(expect.arrayContaining(['202']))
  })
})

describe('страница /api/docs', () => {
  it('открывается без сессии и не требует скриптов', async () => {
    const response = await call(app, { url: '/api/docs' })
    expect(response.statusCode).toBe(200)
    expect(String(response.headers['content-type'])).toContain('text/html')
    // CSP установки разрешает только свои файлы: ни одного <script> на странице
    expect(response.body).not.toContain('<script')
    expect(response.body).toContain('/api/docs/style.css')
    expect(response.body).toContain('Аутентификация')
    expect(response.body).toContain('/objects/batch-get')
  })

  it('стиль отдаётся отдельным файлом того же происхождения', async () => {
    const response = await call(app, { url: '/api/docs/style.css' })
    expect(response.statusCode).toBe(200)
    expect(String(response.headers['content-type'])).toContain('text/css')
  })

  it('экранирует разметку из спецификации', async () => {
    const { renderApiDocs } = await import('../src/shared/http/api-docs.js')
    const html = renderApiDocs({
      info: { title: '<img src=x onerror=alert(1)>' },
      paths: {
        '/x': { get: { summary: '<b>жирный</b>', tags: ['objects'], responses: { '200': {} } } },
      },
    })
    expect(html).not.toContain('<img src=x')
    expect(html).not.toContain('<b>жирный</b>')
    expect(html).toContain('&lt;b&gt;')
  })
})
