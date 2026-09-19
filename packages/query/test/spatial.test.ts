import type { QueryIssue, QuerySpec, QueryStep } from '@kchs/contracts'
import { describe, expect, it } from 'vitest'
import {
  type CompileContext,
  collectSources,
  compileQuery,
  QueryCompileError,
} from '../src/index.js'
import { ctx, IDS, incidents, q, render, src, TERR_DU, TERR_DU_1 } from './fixtures.js'
import {
  box,
  hospitals,
  SPATIAL_IDS,
  spatialContext,
  zones,
  zonesSource,
} from './spatial-fixtures.js'

/**
 * Шаг spatial (ADR-0069): эталоны SQL (снимки), ошибки с путём в спецификации и
 * сбор источников целей. Семантика SQL — в spatial-execute.test.ts на PostGIS.
 */
type Case = [name: string, spec: QuerySpec, overrides?: Partial<CompileContext>]

function compile(spec: QuerySpec, overrides: Partial<CompileContext> = {}) {
  return compileQuery(spec, ctx({ ...spatialContext(), ...overrides }))
}

function golden(cases: Case[]) {
  it.each(cases)('%s', (_name, spec, overrides) => {
    const compiled = compile(spec, overrides)
    expect(render(compiled)).toMatchSnapshot()
    // Каждый параметр упомянут в тексте, лишних номеров нет
    expect(placeholders(compiled.sql)).toEqual(range(compiled.params.length))
    expect(placeholders(compiled.countSql)).toEqual(range(compiled.countParams.length))
    for (const value of compiled.params) {
      if (typeof value === 'string' && value.length >= 5) expect(compiled.sql).not.toContain(value)
    }
  })
}

function placeholders(sql: string): number[] {
  return [...new Set([...sql.matchAll(/\$(\d+)/g)].map((match) => Number(match[1])))].sort(
    (a, b) => a - b,
  )
}

function range(n: number): number[] {
  return Array.from({ length: n }, (_, index) => index + 1)
}

function issue(spec: QuerySpec, overrides: Partial<CompileContext> = {}): QueryIssue {
  try {
    compile(spec, overrides)
  } catch (error) {
    if (error instanceof QueryCompileError) return error.issues[0] as QueryIssue
    throw error
  }
  throw new Error('Компиляция прошла без ошибки')
}

const spatial = (
  op: Extract<QueryStep, { type: 'spatial' }>['op'],
  params: Record<string, unknown> = {},
  target?: unknown,
): QueryStep => ({ type: 'spatial', op, params, ...(target !== undefined ? { target } : {}) })

const hospitalsTarget = { kind: 'dataset', id: SPATIAL_IDS.hospitals, alias: 'h' }
const incidentsTarget = { kind: 'dataset', id: IDS.incidents, alias: 'inc' }
const center = box(68.7, 38.5, 68.9, 38.6)

describe('шаг spatial: SQL', () => {
  golden([
    ['буфер на заданное расстояние', q(src(), [spatial('buffer', { distance: 500 })])],
    [
      'буфер по полю с метрами и параметр запроса',
      q(
        src(),
        [
          spatial('buffer', { distanceField: 'victims' }),
          spatial('buffer', { distance: '@param:radius' }),
        ],
        { radius: { type: 'number', default: 250 } },
      ),
    ],
    ['центроид и точка на поверхности', q(zonesSource(), [spatial('centroid', { inside: true })])],
    [
      'площадь и длина — новыми полями',
      q(zonesSource(), [spatial('area'), spatial('length', { as: 'perimeter_km' })]),
    ],
    ['пересечение с геометрией GeoJSON', q(src(), [spatial('intersects', {}, center)])],
    [
      'внутри территории (с поиском по идентификатору)',
      q(src(), [spatial('within', {}, { kind: 'territory', id: TERR_DU })]),
    ],
    [
      'не в радиусе больниц цели с условием',
      q(src(), [
        spatial(
          'dwithin',
          { distance: 2000, negate: true },
          { ...hospitalsTarget, filter: { field: 'beds', op: 'gte', value: 50 } },
        ),
      ]),
    ],
    [
      'ближайшие больницы: кандидаты по KNN, порядок по geography',
      q(src('inc'), [
        spatial(
          'nearest',
          { limit: 3, maxDistance: 50000, fields: ['h.name', 'beds'] },
          hospitalsTarget,
        ),
      ]),
    ],
    [
      'расстояние до точки',
      q(src(), [
        spatial(
          'nearest',
          { as: 'to_center_m' },
          { kind: 'geometry', geometry: { type: 'Point', coordinates: [68.78, 38.56] } },
        ),
      ]),
    ],
    [
      'присвоение района',
      q(src(), [spatial('assign_territory', { level: 'district', as: 'terr' })]),
    ],
    [
      'пространственное соединение: число и сумма по объектам цели',
      q(zonesSource('z'), [
        spatial(
          'spatial_join',
          {
            measures: [
              { alias: 'incidents', agg: 'count' },
              { alias: 'damage', agg: 'sum', field: 'inc.damage' },
              { alias: 'last_at', agg: 'max', field: 'occurred_at' },
            ],
          },
          incidentsTarget,
        ),
      ]),
    ],
    [
      'пространственное соединение в радиусе',
      q({ kind: 'dataset', id: SPATIAL_IDS.hospitals }, [
        spatial('spatial_join', { predicate: 'dwithin', distance: 3000 }, incidentsTarget),
      ]),
    ],
    [
      'шестиугольники с мерами',
      q(src(), [
        spatial('hexgrid', {
          size: 5000,
          measures: [
            { alias: 'n', agg: 'count' },
            { alias: 'damage', agg: 'avg', field: 'damage' },
          ],
        }),
      ]),
    ],
    ['квадратная сетка: число объектов', q(src(), [spatial('grid', { size: 10000 })])],
    [
      'растворение по полю',
      q(zonesSource(), [
        spatial('dissolve', { by: ['kind'], measures: [{ alias: 'zones', agg: 'count' }] }),
      ]),
    ],
    [
      'вырезание по территориям уровня',
      q(zonesSource(), [spatial('clip', {}, { kind: 'territory', level: 'region' })]),
    ],
    [
      'цепочка: фильтр, буфер, площадь, сортировка и лимит',
      q(src(), [
        { type: 'filter', where: { field: 'kind', op: 'eq', value: 'fire' } },
        { type: 'sort', by: [{ field: 'damage', dir: 'desc' }] },
        spatial('buffer', { distance: 1000 }),
        spatial('area'),
        { type: 'limit', limit: 10, offset: 0 },
      ]),
    ],
    [
      'справочник территорий как источник',
      q({ kind: 'system', name: 'territories' }, [
        { type: 'filter', where: { field: 'level', op: 'eq', value: 'district' } },
        spatial('spatial_join', {}, incidentsTarget),
      ]),
    ],
  ])

  it('после сетки и растворения — поля результата, без порядка и режима таблицы', () => {
    const compiled = compile(
      q(src(), [
        { type: 'sort', by: [{ field: 'damage', dir: 'desc' }] },
        spatial('grid', { size: 10000 }),
      ]),
      { rowMeta: true },
    )
    expect(compiled.fields.map((field) => `${field.name}:${field.type}`)).toEqual([
      'cell:identifier',
      'geom:geometry',
      'count:integer',
    ])
    expect(compiled.sql).not.toContain('ORDER BY "q')
  })

  it('имя по умолчанию занято полем данных — с номером', () => {
    const compiled = compile(q(zonesSource(), [spatial('area'), spatial('area')]))
    expect(compiled.fields.map((field) => field.name).slice(-2)).toEqual(['area_km2', 'area_km2_2'])
  })

  it('поля результата: подписи и типы добавленных полей', () => {
    const compiled = compile(
      q(src(), [
        spatial('assign_territory', { level: 'region' }),
        spatial('area'),
        spatial('nearest', {}, hospitalsTarget),
      ]),
    )
    const added = compiled.fields.slice(-5)
    expect(added.map((field) => [field.name, field.type, field.label?.ru])).toEqual([
      ['region_id', 'territory', 'Регион'],
      ['area_km2', 'number', 'Площадь, км²'],
      ['name', 'text', 'name'],
      ['beds', 'integer', 'beds'],
      ['distance_m', 'number', 'Расстояние, м'],
    ])
  })

  it('политики цели входят в ключ кэша', () => {
    const spec = q(src(), [spatial('intersects', {}, hospitalsTarget)])
    const open = compile(spec)
    const closed = compile(spec, {
      ...spatialContext([incidents, { ...hospitals, rowPolicy: { kind: 'none' } }]),
    })
    expect(open.cacheKeyParts.datasets.map((item) => item.id)).toEqual(
      [IDS.incidents, SPATIAL_IDS.hospitals].sort(),
    )
    expect(closed.sql).toContain('FALSE')
    expect(closed.cacheKeyParts.datasets).not.toEqual(open.cacheKeyParts.datasets)
  })
})

describe('шаг spatial: ошибки', () => {
  const cases: Array<[string, QuerySpec, Partial<QueryIssue>, Partial<CompileContext>?]> = [
    [
      'неизвестный параметр',
      q(src(), [spatial('buffer', { distance: 10, radius: 5 })]),
      { path: ['steps', 0, 'params', 'radius'], message: 'Неизвестный параметр «radius»' },
    ],
    [
      'буфер без расстояния',
      q(src(), [spatial('buffer')]),
      {
        path: ['steps', 0, 'params'],
        message: 'Для буфера нужно расстояние: distance (метры) или distanceField',
      },
    ],
    [
      'буфер: расстояние вне диапазона',
      q(src(), [spatial('buffer', { distance: 0 })]),
      {
        path: ['steps', 0, 'params', 'distance'],
        message: '«distance» — число больше 0 и не больше 1000000',
      },
    ],
    [
      'буфер: поле расстояния — не число',
      q(src(), [spatial('buffer', { distanceField: 'title' })]),
      {
        path: ['steps', 0, 'params', 'distanceField'],
        message: 'Расстояние буфера — число метров, а «title» — строка',
      },
    ],
    [
      'параметр запроса не задан',
      q(src(), [spatial('buffer', { distance: '@param:radius' })], { radius: { type: 'number' } }),
      { path: ['steps', 0, 'params', 'distance'], message: 'Не задан параметр «radius»' },
    ],
    [
      'нет цели у пересечения',
      q(src(), [spatial('intersects')]),
      { path: ['steps', 0, 'target'], message: 'Для операции «intersects» нужна цель' },
    ],
    [
      'цель у буфера',
      q(src(), [spatial('buffer', { distance: 10 }, center)]),
      { path: ['steps', 0, 'target'], message: 'У операции «buffer» цели нет' },
    ],
    [
      'нет поля геометрии',
      q({ kind: 'dataset', id: IDS.regions }, [spatial('area')]),
      { path: ['steps', 0, 'params', 'field'], message: 'В данных нет поля геометрии' },
    ],
    [
      'несколько полей геометрии',
      q(src('inc'), [
        {
          type: 'join',
          source: { kind: 'dataset', id: SPATIAL_IDS.zones, alias: 'z' },
          on: [{ left: 'inc.kind', right: 'z.kind' }],
          kind: 'left',
        },
        spatial('centroid'),
      ]),
      {
        path: ['steps', 1, 'params', 'field'],
        message: 'В данных несколько полей геометрии: inc.geom, z.geom',
      },
    ],
    [
      'поле — не геометрия',
      q(src(), [spatial('centroid', { field: 'title' })]),
      { path: ['steps', 0, 'params', 'field'], message: 'Поле «title» — не геометрия, а строка' },
    ],
    [
      'присвоение территории без уровня',
      q(src(), [spatial('assign_territory')]),
      {
        path: ['steps', 0, 'params', 'level'],
        message: 'Уровень территории — один из: country, region, district, jamoat, settlement',
      },
    ],
    [
      'справочник территорий недоступен',
      q(src(), [spatial('assign_territory', { level: 'district' })]),
      {
        path: ['steps', 0, 'params', 'level', 'name'],
        message: 'Системный датасет «territories» недоступен',
      },
      { systemDatasets: new Map() },
    ],
    [
      'соединение с геометрией-значением',
      q(zonesSource(), [spatial('spatial_join', {}, center)]),
      {
        path: ['steps', 0, 'target'],
        message: 'Для операции «spatial_join» цель — датасет, сохранённый запрос или территории',
      },
    ],
    [
      'сумма по строкам',
      q(zonesSource(), [
        spatial(
          'spatial_join',
          { measures: [{ alias: 's', agg: 'sum', field: 'title' }] },
          incidentsTarget,
        ),
      ]),
      {
        path: ['steps', 0, 'params', 'measures', 0, 'field'],
        message: 'Мера «sum» считается по числам, а получено: строка',
      },
    ],
    [
      'имя меры совпадает с полем',
      q(zonesSource(), [
        spatial('spatial_join', { measures: [{ alias: 'name', agg: 'count' }] }, incidentsTarget),
      ]),
      { path: ['steps', 0, 'params', 'measures', 0, 'alias'], message: 'Поле «name» уже есть' },
    ],
    [
      'расстояние у предиката без радиуса',
      q(zonesSource(), [spatial('spatial_join', { distance: 10 }, incidentsTarget)]),
      {
        path: ['steps', 0, 'params', 'distance'],
        message: 'Расстояние задаётся только для предиката dwithin',
      },
    ],
    [
      'ближайший к геометрии: лишний limit',
      q(src(), [spatial('nearest', { limit: 2 }, center)]),
      {
        path: ['steps', 0, 'params', 'limit'],
        message: 'Для цели-геометрии параметр «limit» не задаётся',
      },
    ],
    [
      'ближайший: алиас цели занят',
      q(src('h'), [spatial('nearest', {}, hospitalsTarget)]),
      { path: ['steps', 0, 'target', 'alias'], message: 'Алиас «h» уже используется' },
    ],
    [
      'добавляемое поле уже есть',
      q(zonesSource(), [spatial('area'), spatial('area', { as: 'area_km2' })]),
      { path: ['steps', 1, 'params', 'as'], message: 'Поле «area_km2» уже есть' },
    ],
    [
      'территории без идентификаторов и уровня',
      q(src(), [spatial('within', {}, { kind: 'territory' })]),
      { path: ['steps', 0, 'target'], message: 'Для цели-территорий нужны id, ids или level' },
    ],
    [
      'неизвестный вид цели',
      q(src(), [spatial('within', {}, { kind: 'layer', id: IDS.regions })]),
      {
        path: ['steps', 0, 'target', 'kind'],
        message: 'Вид цели — dataset, query, system, territory или geometry',
      },
    ],
    [
      'цель — не геометрия GeoJSON',
      q(src(), [spatial('intersects', {}, { kind: 'geometry', geometry: { type: 'Circle' } })]),
      { path: ['steps', 0, 'target', 'geometry'], message: 'Ожидалась геометрия GeoJSON' },
    ],
    [
      'датасет цели недоступен',
      q(src(), [
        spatial('intersects', {}, { kind: 'dataset', id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }),
      ]),
      { path: ['steps', 0, 'target', 'id'], message: 'Датасет не найден или нет доступа' },
    ],
    [
      'в цели нет геометрии',
      q(src(), [spatial('intersects', {}, { kind: 'dataset', id: IDS.regions })]),
      { path: ['steps', 0, 'target', 'field'], message: 'В цели нет поля геометрии' },
    ],
    [
      'скрытое политикой поле цели',
      q(zonesSource(), [
        spatial(
          'spatial_join',
          { measures: [{ alias: 'damage', agg: 'sum', field: 'damage' }] },
          incidentsTarget,
        ),
      ]),
      {
        path: ['steps', 0, 'params', 'measures', 0, 'field'],
        message: 'Нет доступа к полю «damage»',
      },
      spatialContext([{ ...incidents, columnPolicy: { hide: ['damage'], mask: [] } }, zones]),
    ],
    [
      'растворение по геометрии',
      q(zonesSource(), [spatial('dissolve', { by: ['geom'] })]),
      {
        path: ['steps', 0, 'params', 'by', 0],
        message: 'Растворять по геометрии нельзя — укажите поле-признак',
      },
    ],
    [
      'сетка мельче 10 м',
      q(src(), [spatial('hexgrid', { size: 5 })]),
      {
        path: ['steps', 0, 'params', 'size'],
        message: '«size» — число не меньше 10 и не больше 1000000',
      },
    ],
  ]
  it.each(cases)('%s', (_name, spec, expected, overrides) => {
    expect(issue(spec, overrides)).toMatchObject(expected)
  })
})

describe('шаг spatial: источники целей', () => {
  it('датасеты, запросы и справочник территорий', () => {
    const spec = q(src(), [
      spatial('nearest', {}, hospitalsTarget),
      spatial('within', {}, { kind: 'territory', ids: [TERR_DU_1] }),
      spatial('clip', {}, { kind: 'query', id: IDS.savedTotals }),
      spatial('assign_territory', { level: 'district' }),
      spatial('intersects', {}, center),
    ])
    expect(collectSources(spec)).toEqual({
      datasets: [IDS.incidents, SPATIAL_IDS.hospitals],
      queries: [IDS.savedTotals],
      system: ['territories'],
      sql: false,
    })
  })

  it('источник-территории без цели', () => {
    expect(
      collectSources(q({ kind: 'system', name: 'territories' }, [spatial('area')])),
    ).toMatchObject({ datasets: [], system: ['territories'] })
  })
})
