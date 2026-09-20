import { API_SCOPES, scopeSatisfied } from '@kchs/contracts'
import { describe, expect, it } from 'vitest'
import { requiredScope } from './scopes.js'

/**
 * Область доступа маршрута (ADR-0097). Список закрыт по умолчанию: маршрут без
 * отображаемого тега токенам недоступен, личные и административные пути закрыты
 * при любых областях.
 */
describe('область доступа маршрута', () => {
  it('чтение и запись различаются по методу', () => {
    expect(requiredScope({ method: 'GET', url: '/datasets/:id', tags: ['data'] }).scope).toBe(
      'read:datasets',
    )
    expect(requiredScope({ method: 'POST', url: '/datasets', tags: ['data'] }).scope).toBe(
      'write:datasets',
    )
    expect(requiredScope({ method: 'DELETE', url: '/datasets/:id', tags: ['data'] }).scope).toBe(
      'write:datasets',
    )
  })

  it('POST без изменения данных требует только чтения', () => {
    expect(
      requiredScope({
        method: 'POST',
        url: '/objects/batch-get',
        tags: ['objects'],
        readOnly: true,
      }).scope,
    ).toBe('read:objects')
  })

  it('личные, входные и административные пути закрыты', () => {
    for (const url of [
      '/me',
      '/me/telegram',
      '/auth/login',
      '/internal/jobs/:id/status',
      '/admin/audit',
      '/share/:token/open',
      '/hooks/:id/:secret',
    ]) {
      expect(requiredScope({ method: 'GET', url, tags: ['integrations'] }).scope, url).toBeNull()
    }
  })

  it('незнакомый тег и маршрут без тегов токенам недоступны', () => {
    expect(requiredScope({ method: 'GET', url: '/something', tags: ['новый-модуль'] }).scope).toBe(
      null,
    )
    expect(requiredScope({ method: 'GET', url: '/something', tags: undefined }).scope).toBeNull()
  })

  it('теги ИИ и внутренних маршрутов закрыты независимо от пути', () => {
    expect(
      requiredScope({ method: 'POST', url: '/datasets/:id/ask', tags: ['ai'] }).scope,
    ).toBeNull()
    expect(
      requiredScope({ method: 'POST', url: '/documents/renders', tags: ['internal'] }).scope,
    ).toBeNull()
  })

  it('префикс `/api/v1` в пути не мешает', () => {
    expect(requiredScope({ method: 'GET', url: '/api/v1/me/sessions', tags: ['me'] }).scope).toBe(
      null,
    )
    expect(requiredScope({ method: 'GET', url: '/api/v1/tasks', tags: ['tasks'] }).scope).toBe(
      'read:tasks',
    )
  })

  it('выводит только области из справочника; запись в «только чтение» закрыта', () => {
    const known = new Set<string>(API_SCOPES)
    const produced = new Set<string>()
    for (const tag of ['objects', 'data', 'documents', 'tasks', 'integrations', 'search', 'jobs']) {
      for (const method of ['GET', 'POST']) {
        const { scope } = requiredScope({ method, url: '/x', tags: [tag] })
        if (scope) produced.add(scope)
      }
    }
    expect([...produced].filter((scope) => !known.has(scope))).toEqual([])
    // У поиска и заданий записи не бывает — изменяющий маршрут токенам закрыт
    expect(requiredScope({ method: 'POST', url: '/jobs/:id/cancel', tags: ['jobs'] }).scope).toBe(
      null,
    )
  })

  it('запись подразумевает чтение того же ресурса', () => {
    expect(scopeSatisfied(['write:datasets'], 'read:datasets')).toBe(true)
    expect(scopeSatisfied(['read:datasets'], 'write:datasets')).toBe(false)
    expect(scopeSatisfied(['read:tasks'], 'read:datasets')).toBe(false)
    expect(scopeSatisfied([], 'read:objects')).toBe(false)
  })
})
