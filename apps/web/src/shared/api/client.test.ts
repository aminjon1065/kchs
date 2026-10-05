import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, http, setCsrfToken } from './client.js'
import { apiUrl } from './link.js'

/** Ответ fetch: JSON с кодом или пустой 204. */
const reply = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.stubGlobal('window', { location: { origin: 'http://web' } })
  vi.stubGlobal('document', { documentElement: { lang: 'ru' } })
  fetchMock = vi.fn(async () => reply(200, { ok: true }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  setCsrfToken(null)
  vi.unstubAllGlobals()
})

const lastCall = () => {
  const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit]
  return { url, init, headers: init.headers as Record<string, string> }
}

describe('клиент API по таблице маршрутов (ADR-0188)', () => {
  it('параметры пути подставляются и кодируются', async () => {
    await http.get('/tasks/:id', { params: { id: 'a b/c' } })
    const { url, init, headers } = lastCall()
    expect(url).toBe('http://web/api/v1/tasks/a%20b%2Fc')
    expect(init.method).toBe('GET')
    expect(headers.accept).toBe('application/json')
    expect(headers['content-type']).toBeUndefined()
  })

  it('строка запроса — без пустых значений', async () => {
    await http.get('/tasks', { query: { scope: 'mine', q: '', limit: 5, projectId: undefined } })
    expect(lastCall().url).toBe('http://web/api/v1/tasks?scope=mine&limit=5')
  })

  it('тело — JSON с CSRF-токеном изменяющего запроса', async () => {
    setCsrfToken('token-1')
    await http.post('/tasks/:id/reassign', {
      params: { id: 't1' },
      body: { assigneeId: 'u1', comment: 'срочно' },
    })
    const { url, init, headers } = lastCall()
    expect(url).toBe('http://web/api/v1/tasks/t1/reassign')
    expect(init.method).toBe('POST')
    expect(init.body).toBe(JSON.stringify({ assigneeId: 'u1', comment: 'срочно' }))
    expect(headers['content-type']).toBe('application/json')
    expect(headers['x-csrf-token']).toBe('token-1')
  })

  it('204 — пустой ответ, keepalive доходит до fetch', async () => {
    fetchMock.mockResolvedValueOnce(reply(204))
    const result = await http.put('/me/workspace-state', {
      body: { state: null },
      keepalive: true,
    })
    expect(result).toBeUndefined()
    expect(lastCall().init.keepalive).toBe(true)
  })

  it('ошибка — ApiError с проблемой сервера', async () => {
    fetchMock.mockResolvedValueOnce(
      reply(404, { type: 'about:blank', title: 'Нет', status: 404, code: 'not_found' }),
    )
    const failure = await http.get('/me').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ApiError)
    expect((failure as ApiError).status).toBe(404)
    expect((failure as ApiError).code).toBe('not_found')
  })

  it('незаданный параметр пути — ошибка до запроса', async () => {
    await expect(http.get('/tasks/:id', { params: { id: '' } })).rejects.toThrow(
      'нет параметра пути id',
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('адрес ссылки — путь и строка запроса по таблице', () => {
    expect(apiUrl('/admin/users/import/:importId/report.csv', { params: { importId: 'i1' } })).toBe(
      '/api/v1/admin/users/import/i1/report.csv',
    )
    expect(apiUrl('/admin/audit/export.csv', { query: { action: 'user.login' } })).toBe(
      '/api/v1/admin/audit/export.csv?action=user.login',
    )
  })
})
