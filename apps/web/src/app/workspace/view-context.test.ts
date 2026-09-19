import { beforeEach, describe, expect, it } from 'vitest'
import {
  freeLinkGroup,
  idsOfSpans,
  LINKED_SELECTION_LIMIT,
  linkKey,
  useViewContext,
} from './view-context.js'

const store = () => useViewContext.getState()
const entry = (group: string, datasetId: string) => store().links[linkKey(group, datasetId)]

beforeEach(() => {
  useViewContext.setState({ links: {} })
})

describe('связанные представления: хранилище группы', () => {
  it('выделение источника: публикация, та же — без изменений, пустое снимает', () => {
    store().select('blue', 'ds1', ['1', '2'], 'table')
    const first = entry('blue', 'ds1')?.selection
    expect(first).toEqual({ ids: ['1', '2'], source: 'table' })
    // Та же публикация — тот же объект: подписчики не перерисовываются
    store().select('blue', 'ds1', ['1', '2'], 'table')
    expect(entry('blue', 'ds1')?.selection).toBe(first)
    // Чужой источник с теми же строками — новая публикация (другой владелец)
    store().select('blue', 'ds1', ['1', '2'], 'map')
    expect(entry('blue', 'ds1')?.selection?.source).toBe('map')
    // Пустое выделение чужого источника не стирает выделение (открылась таблица без выделения)
    store().select('blue', 'ds1', [], 'table')
    expect(entry('blue', 'ds1')?.selection?.source).toBe('map')
    store().select('blue', 'ds1', [], 'map')
    expect(entry('blue', 'ds1')?.selection).toEqual({ ids: [], source: 'map' })
  })

  it('группы и датасеты независимы', () => {
    store().select('blue', 'ds1', ['1'], 'table')
    store().select('green', 'ds1', ['9'], 'table-2')
    store().select('blue', 'ds2', ['5'], 'map')
    expect(entry('blue', 'ds1')?.selection?.ids).toEqual(['1'])
    expect(entry('green', 'ds1')?.selection?.ids).toEqual(['9'])
    expect(entry('blue', 'ds2')?.selection?.ids).toEqual(['5'])
  })

  it('выделение ограничено пределом строк', () => {
    const ids = Array.from({ length: LINKED_SELECTION_LIMIT + 10 }, (_, i) => String(i))
    store().select('blue', 'ds1', ids, 'table')
    expect(entry('blue', 'ds1')?.selection?.ids).toHaveLength(LINKED_SELECTION_LIMIT)
  })

  it('фильтр: снимает только его источник, чип потребителя — принудительно', () => {
    const where = { field: 'day', op: 'between' as const, value: ['2026-03-01', '2026-05-31'] }
    store().filter('blue', 'ds1', { where, label: 'День' }, 'chart')
    expect(entry('blue', 'ds1')?.filter).toMatchObject({ source: 'chart', label: 'День' })
    store().filter('blue', 'ds1', null, 'map')
    expect(entry('blue', 'ds1')?.filter?.source).toBe('chart')
    store().filter('blue', 'ds1', null, 'map', true)
    expect(entry('blue', 'ds1')).toBeUndefined()
  })

  it('охват карты: повтор без изменений, снятие своим источником', () => {
    store().extent('blue', 'ds1', { bbox: [68, 38, 69, 39], field: 'place' }, 'map')
    const first = entry('blue', 'ds1')?.extent
    store().extent('blue', 'ds1', { bbox: [68, 38, 69, 39], field: 'place' }, 'map')
    expect(entry('blue', 'ds1')?.extent).toBe(first)
    store().extent('blue', 'ds1', null, 'table')
    expect(entry('blue', 'ds1')?.extent).toBe(first)
    store().extent('blue', 'ds1', null, 'map')
    expect(entry('blue', 'ds1')).toBeUndefined()
  })

  it('закрытое представление снимает все свои публикации', () => {
    store().select('blue', 'ds1', ['1'], 'map')
    store().extent('blue', 'ds1', { bbox: [68, 38, 69, 39], field: 'place' }, 'map')
    store().extent('blue', 'ds2', { bbox: [68, 38, 69, 39], field: 'geom' }, 'map')
    store().filter(
      'blue',
      'ds1',
      { where: { field: 'kind', op: 'in', value: ['a'] }, label: 'Вид' },
      'chart',
    )
    store().clearSource('map')
    expect(entry('blue', 'ds1')).toEqual({
      selection: null,
      filter: expect.objectContaining({ source: 'chart' }),
      extent: null,
    })
    expect(entry('blue', 'ds2')).toBeUndefined()
  })
})

describe('помощники связи', () => {
  it('строки выделенных отрезков грида — только загруженные', () => {
    const loaded = new Map([
      [0, 'a'],
      [1, 'b'],
      [5, 'f'],
    ])
    expect(
      idsOfSpans(
        [
          [0, 1],
          [4, 6],
        ],
        (index) => loaded.get(index),
      ),
    ).toEqual(['a', 'b', 'f'])
    expect(idsOfSpans([[0, 5]], (index) => loaded.get(index), 2)).toEqual(['a', 'b'])
  })

  it('свободная группа — первая неиспользованная', () => {
    expect(freeLinkGroup([])).toBe('blue')
    expect(freeLinkGroup(['blue', null, undefined])).toBe('orange')
  })
})
