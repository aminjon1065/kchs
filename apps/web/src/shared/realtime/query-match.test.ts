import { describe, expect, it } from 'vitest'
import { keyMentions } from './query-match.js'

const id = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'
const other = '0199a1b2-c3d4-7e5f-8a9b-ffffffffffff'

describe('keyMentions', () => {
  it('находит id объекта в ключах модулей', () => {
    expect(keyMentions(['object', id], id)).toBe(true)
    expect(keyMentions(['object', id, 'activity'], id)).toBe(true)
    expect(keyMentions(['dataset', id, 'versions'], id)).toBe(true)
    expect(keyMentions(['layer', id, 'feature', '42'], id)).toBe(true)
    expect(keyMentions(['layers', 'dataset', id], id)).toBe(true)
  })

  it('находит id в параметрах запроса первого уровня', () => {
    expect(keyMentions(['rows', { datasetId: id, page: 2 }], id)).toBe(true)
    expect(keyMentions(['rows', { filter: { datasetId: id } }], id)).toBe(false)
  })

  it('не задевает чужие объекты и частичные совпадения', () => {
    expect(keyMentions(['dataset', other], id)).toBe(false)
    expect(keyMentions(['objects', { parentId: other }], id)).toBe(false)
    expect(keyMentions(['search', { q: id.slice(0, 8) }], id)).toBe(false)
    expect(keyMentions(['notifications', true], id)).toBe(false)
    expect(keyMentions(['inbox', null], id)).toBe(false)
  })
})
