import type { FieldType, FilterNode } from '@kchs/contracts'
import { featureFilter } from '@maplibre/maplibre-gl-style-spec'
import { describe, expect, it } from 'vitest'
import { type Condition, condition } from '../expr.js'
import { compileFilter, type FilterContext, type Polarity } from '../filter.js'
import { FIELDS } from './fixtures.js'

const TYPES = new Map<string, FieldType>(FIELDS.map((field) => [field.key, field.type]))

function compile(
  node: FilterNode,
  polarity: Polarity = 'under',
  options: Partial<FilterContext> = {},
): { condition: Condition; unsupported: string[] } {
  const unsupported: string[] = []
  const result = compileFilter(
    node,
    {
      fieldType: (key) => TYPES.get(key) ?? null,
      timezone: 'Asia/Dushanbe',
      unsupported: (path, detail) => unsupported.push(`${path}: ${detail}`),
      ...options,
    },
    polarity,
    'filter',
  )
  return { condition: result, unsupported }
}

/** Проходит ли объект с такими свойствами условие (вычисляет MapLibre). */
function check(node: FilterNode, options: Partial<FilterContext> = {}) {
  const { condition: result } = compile(node, 'under', options)
  const filter = featureFilter(condition(result), 'layers.test.filter')
  return (properties: Record<string, unknown>) =>
    filter.filter({ zoom: 10 } as never, { type: 1, properties } as never)
}

describe('FilterNode → выражение MapLibre', () => {
  it('eq и neq: строки, числа (в том числе строкой), пустое; neq пропускает пустые', () => {
    const kind = check({ field: 'kind', op: 'eq', value: 'school' })
    expect(kind({ kind: 'school' })).toBe(true)
    expect(kind({ kind: 'School' })).toBe(false)
    expect(kind({})).toBe(false)
    const severity = check({ field: 'severity', op: 'eq', value: '3' })
    expect(severity({ severity: 3 })).toBe(true)
    expect(severity({ severity: '3' })).toBe(true)
    expect(check({ field: 'severity', op: 'eq', value: 0 })({})).toBe(false)
    const other = check({ field: 'kind', op: 'neq', value: 'school' })
    expect(other({ kind: 'police' })).toBe(true)
    expect(other({})).toBe(true)
    expect(other({ kind: 'school' })).toBe(false)
    expect(check({ field: 'kind', op: 'eq', value: null })({})).toBe(true)
    expect(check({ field: 'kind', op: 'neq', value: null })({ kind: 'x' })).toBe(true)
  })

  it('in и not_in: списки строк и чисел, пустое в списке', () => {
    const kinds = check({ field: 'kind', op: 'in', value: ['school', 'police'] })
    expect(kinds({ kind: 'police' })).toBe(true)
    expect(kinds({ kind: 'hospital' })).toBe(false)
    expect(kinds({})).toBe(false)
    const withNull = check({ field: 'kind', op: 'in', value: ['school', null] })
    expect(withNull({})).toBe(true)
    const notIn = check({ field: 'kind', op: 'not_in', value: ['school'] })
    expect(notIn({})).toBe(true)
    expect(notIn({ kind: 'school' })).toBe(false)
    expect(check({ field: 'kind', op: 'not_in', value: ['school', null] })({})).toBe(false)
    const numbers = check({ field: 'severity', op: 'in', value: [1, 0] })
    expect(numbers({ severity: 0 })).toBe(true)
    expect(numbers({})).toBe(false)
    const fractions = check({ field: 'ratio', op: 'in', value: [0.5, 1.25] })
    expect(fractions({ ratio: 1.25 })).toBe(true)
    expect(fractions({ ratio: 1 })).toBe(false)
    expect(check({ field: 'kind', op: 'in', value: [] })({ kind: 'school' })).toBe(false)
  })

  it('сравнения и between: концы включительно, пустой конец — без ограничения', () => {
    const gt = check({ field: 'population', op: 'gt', value: 1000 })
    expect(gt({ population: 1001 })).toBe(true)
    expect(gt({ population: 1000 })).toBe(false)
    expect(gt({})).toBe(false)
    expect(check({ field: 'population', op: 'lte', value: 1000 })({ population: 1000 })).toBe(true)
    const between = check({ field: 'population', op: 'between', value: [10, 20] })
    expect(between({ population: 10 })).toBe(true)
    expect(between({ population: 20 })).toBe(true)
    expect(between({ population: 21 })).toBe(false)
    const open = check({ field: 'population', op: 'between', value: { from: 10, to: null } })
    expect(open({ population: 1e9 })).toBe(true)
    expect(open({ population: 9 })).toBe(false)
    expect(check({ field: 'name', op: 'lt', value: 'Б' })({ name: 'Аштрахан' })).toBe(true)
  })

  it('пустота: у текста пустая строка — тоже пусто', () => {
    const empty = check({ field: 'name', op: 'is_empty' })
    expect(empty({})).toBe(true)
    expect(empty({ name: '' })).toBe(true)
    expect(empty({ name: 'Хорог' })).toBe(false)
    expect(check({ field: 'population', op: 'is_empty' })({ population: 0 })).toBe(false)
    const filled = check({ field: 'name', op: 'not_empty' })
    expect(filled({ name: 'Хорог' })).toBe(true)
    expect(filled({ name: '' })).toBe(false)
    expect(check({ field: 'tags', op: 'is_empty' })({})).toBe(true)
  })

  it('подстрока без учёта регистра: contains, starts_with, ends_with, not_contains', () => {
    const contains = check({ field: 'name', op: 'contains', value: 'ШКОЛА' })
    expect(contains({ name: 'Средняя школа №5' })).toBe(true)
    expect(contains({ name: 'Больница' })).toBe(false)
    expect(contains({})).toBe(false)
    expect(check({ field: 'name', op: 'starts_with', value: 'сред' })({ name: 'Средняя' })).toBe(
      true,
    )
    expect(check({ field: 'name', op: 'starts_with', value: 'няя' })({ name: 'Средняя' })).toBe(
      false,
    )
    const ends = check({ field: 'name', op: 'ends_with', value: '№5' })
    expect(ends({ name: 'Школа №5' })).toBe(true)
    expect(ends({ name: '№5 школа' })).toBe(false)
    expect(ends({ name: '5' })).toBe(false)
    const without = check({ field: 'name', op: 'not_contains', value: 'школа' })
    expect(without({})).toBe(true)
    expect(without({ name: 'Школа' })).toBe(false)
  })

  it('группы: and, or, not; not пропускает пустые', () => {
    const node: FilterNode = {
      or: [
        {
          and: [
            { field: 'kind', op: 'eq', value: 'school' },
            { field: 'active', op: 'is_true' },
          ],
        },
        { not: { field: 'severity', op: 'lt', value: 4 } },
      ],
    }
    const matches = check(node)
    expect(matches({ kind: 'school', active: true })).toBe(true)
    expect(matches({ kind: 'school', active: false, severity: 1 })).toBe(false)
    expect(matches({ severity: 5 })).toBe(true)
    expect(matches({})).toBe(true)
    expect(check({ field: 'active', op: 'is_false' })({ active: false })).toBe(true)
  })

  it('даты: день поля date — полночь UTC; день поля datetime — сутки в поясе', () => {
    const day = check({ field: 'reported_on', op: 'eq', value: '2026-09-01' })
    expect(day({ reported_on: Date.UTC(2026, 8, 1) })).toBe(true)
    expect(day({ reported_on: Date.UTC(2026, 8, 2) })).toBe(false)
    // Душанбе — UTC+5: сутки 1 сентября — с 19:00 UTC 31 августа
    const moment = check({ field: 'occurred_at', op: 'eq', value: '2026-09-01' })
    expect(moment({ occurred_at: Date.UTC(2026, 7, 31, 19, 0) })).toBe(true)
    expect(moment({ occurred_at: Date.UTC(2026, 8, 1, 18, 59) })).toBe(true)
    expect(moment({ occurred_at: Date.UTC(2026, 8, 1, 19, 0) })).toBe(false)
    const earlier = check({ field: 'occurred_at', op: 'before', value: '2026-09-01' })
    expect(earlier({ occurred_at: Date.UTC(2026, 7, 31, 18, 59) })).toBe(true)
    expect(earlier({ occurred_at: Date.UTC(2026, 7, 31, 19, 0) })).toBe(false)
    const lte = check({ field: 'occurred_at', op: 'lte', value: '2026-09-01' })
    expect(lte({ occurred_at: Date.UTC(2026, 8, 1, 18, 0) })).toBe(true)
    const later = check({ field: 'occurred_at', op: 'after', value: '2026-09-01T10:00:00Z' })
    expect(later({ occurred_at: Date.UTC(2026, 8, 1, 10, 0, 1) })).toBe(true)
    // Время без пояса — местное время пояса контекста
    const local = check({ field: 'occurred_at', op: 'gte', value: '2026-09-01T10:00' })
    expect(local({ occurred_at: Date.UTC(2026, 8, 1, 5, 0) })).toBe(true)
    expect(local({ occurred_at: Date.UTC(2026, 8, 1, 4, 59) })).toBe(false)
    const range = check({
      field: 'occurred_at',
      op: 'between',
      value: ['2026-09-01', '2026-09-02'],
    })
    expect(range({ occurred_at: Date.UTC(2026, 8, 2, 18, 0) })).toBe(true)
    expect(range({ occurred_at: Date.UTC(2026, 8, 2, 19, 0) })).toBe(false)
  })

  it('относительный период и макросы @today/@now — по «сейчас» контекста', () => {
    const now = Date.UTC(2026, 8, 19, 8, 0)
    // Прошлый месяц и этот: с 1 августа по 30 сентября включительно (пояс Душанбе)
    const months = check(
      { field: 'occurred_at', op: 'relative', value: { unit: 'month', from: -1, to: 0 } },
      { now },
    )
    expect(months({ occurred_at: Date.UTC(2026, 6, 31, 19, 0) })).toBe(true)
    expect(months({ occurred_at: Date.UTC(2026, 6, 31, 18, 59) })).toBe(false)
    expect(months({ occurred_at: Date.UTC(2026, 8, 30, 18, 59) })).toBe(true)
    expect(months({ occurred_at: Date.UTC(2026, 8, 30, 19, 0) })).toBe(false)
    // Эта неделя (с понедельника 14 сентября) у поля date
    const week = check(
      { field: 'reported_on', op: 'relative', value: { unit: 'week', from: 0, to: 0 } },
      { now },
    )
    expect(week({ reported_on: Date.UTC(2026, 8, 14) })).toBe(true)
    expect(week({ reported_on: Date.UTC(2026, 8, 20) })).toBe(true)
    expect(week({ reported_on: Date.UTC(2026, 8, 13) })).toBe(false)
    const today = check({ field: 'reported_on', op: 'eq', value: '@today' }, { now })
    expect(today({ reported_on: Date.UTC(2026, 8, 19) })).toBe(true)
    const past = check({ field: 'occurred_at', op: 'lt', value: '@now' }, { now })
    expect(past({ occurred_at: now - 1 })).toBe(true)
    expect(past({ occurred_at: now })).toBe(false)
  })

  it('территория: within с дочерними из иерархии контекста', () => {
    const descendants = (id: string) => (id === 'rudaki' ? ['rudaki-1', 'rudaki-2'] : [])
    const within = check(
      { field: 'territory_id', op: 'within', value: { id: 'rudaki', includeChildren: true } },
      { territoryDescendants: descendants },
    )
    expect(within({ territory_id: 'rudaki-2' })).toBe(true)
    expect(within({ territory_id: 'vahdat' })).toBe(false)
    const own = check({
      field: 'territory_id',
      op: 'within',
      value: { id: 'rudaki', includeChildren: false },
    })
    expect(own({ territory_id: 'rudaki' })).toBe(true)
    expect(own({ territory_id: 'rudaki-1' })).toBe(false)
  })

  it('неизвестное на клиенте: «может выполниться» для фильтра слоя, «не выполняется» для правил', () => {
    const node: FilterNode = { field: 'territory_id', op: 'is_me' }
    expect(compile(node, 'over')).toEqual({
      condition: true,
      unsupported: ['filter: is_me: оператор не вычисляется на карте'],
    })
    expect(compile(node, 'under').condition).toBe(false)
    // Под «не» полярность меняется: «не (неизвестно)» тоже не прячет объекты
    expect(compile({ not: node }, 'over').condition).toBe(true)
    expect(compile({ not: node }, 'under').condition).toBe(false)
    const macro = compile({ field: 'territory_id', op: 'in', value: ['@my_territories'] }, 'over')
    expect(macro.condition).toBe(true)
    expect(macro.unsupported).toEqual(['filter: макрос @my_territories вычисляет сервер'])
    expect(compile({ field: 'kind', op: 'regex', value: '^a' }, 'over').condition).toBe(true)
    expect(compile({ field: 'tags', op: 'contains', value: 'a' }, 'under').condition).toBe(false)
    expect(
      compile({ field: 'territory_id', op: 'within', value: { id: 'x', includeChildren: true } })
        .unsupported,
    ).toEqual(['filter: within: нет иерархии территорий в контексте'])
    // Относительный период без «сейчас» неизвестен
    expect(
      compile({ field: 'occurred_at', op: 'relative', value: { unit: 'day', from: 0, to: 0 } })
        .condition,
    ).toBe(false)
  })

  it('упрощение: всё «может выполниться» — фильтра нет; одно условие — без обёртки all', () => {
    const node: FilterNode = {
      and: [
        { field: 'territory_id', op: 'is_me' },
        { field: 'kind', op: 'eq', value: 'school' },
      ],
    }
    expect(compile(node, 'over').condition).toEqual([
      '==',
      ['to-string', ['get', 'kind']],
      'school',
    ])
    expect(compile({ or: [{ field: 'territory_id', op: 'is_me' }, node] }, 'over').condition).toBe(
      true,
    )
  })
})
