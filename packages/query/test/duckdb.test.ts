import type { QuerySpec } from '@kchs/contracts'
import { describe, expect, it } from 'vitest'
import {
  type CompileContext,
  compileQuery,
  duckdbDialect,
  postgresDialect,
  UnsupportedByDialectError,
} from '../src/index.js'
import {
  ctx,
  dataset,
  IDS,
  INCIDENT_FIELDS,
  incidents,
  q,
  render,
  src,
  withDatasets,
} from './fixtures.js'

/**
 * Диалект DuckDB колоночного tier (ADR-0109). Эталоны «спецификация → SQL»
 * лежат рядом со снимками Postgres: видно, чем отличается текст. Семантику
 * этого SQL проверяет `apps/engine/tests/test_columnar.py` на настоящей DuckDB.
 *
 * Главное здесь — политики: подзапрос с политикой строк, маскирование столбцов
 * и барьер оптимизатора в колоночном пути такие же, как в Postgres.
 */

/** Поля, которые лежат в колоночной копии (геометрии и вычисляемых там нет). */
const COLUMNAR_FIELDS = INCIDENT_FIELDS.filter(
  ([, type]) => type !== 'geometry' && type !== 'formula',
)

const columnar = dataset(IDS.incidents, 'ds.t_incidents', COLUMNAR_FIELDS)

function duck(spec: QuerySpec, overrides: Partial<CompileContext> = {}) {
  return compileQuery(spec, {
    ...ctx({ datasets: new Map([[columnar.id, columnar]]), ...overrides }),
    dialect: duckdbDialect,
  })
}

function golden(cases: Array<[string, QuerySpec, Partial<CompileContext>?]>) {
  it.each(cases)('%s', (_name, spec, overrides) => {
    const compiled = duck(spec, overrides)
    expect(render(compiled)).toMatchSnapshot()
    // Значения пользователя — только параметрами, как и в Postgres
    for (const value of compiled.params) {
      if (typeof value === 'string' && value.length >= 5) expect(compiled.sql).not.toContain(value)
    }
    // Конструкции, которых в DuckDB нет (типы и функции Postgres)
    for (const postgresOnly of [
      '::jsonb',
      '::numeric',
      '::geometry',
      '= ANY(',
      'make_interval',
      'pg_input_is_valid',
      'ST_',
    ]) {
      expect(compiled.sql).not.toContain(postgresOnly)
    }
  })
}

const policyRows: Partial<CompileContext> = {
  datasets: new Map([
    [
      columnar.id,
      {
        ...columnar,
        rowPolicy: {
          kind: 'filter' as const,
          where: { field: 'territory_id', op: 'in' as const, value: '@my_territories' },
        },
      },
    ],
  ]),
}

const policyColumns: Partial<CompileContext> = {
  datasets: new Map([
    [
      columnar.id,
      {
        ...columnar,
        columnPolicy: {
          hide: ['notes'],
          mask: ['phone', 'email', 'damage', 'ratio', 'occurred_at', 'reported_on', 'code'],
        },
      },
    ],
  ]),
}

describe('DuckDB: выборка и агрегаты', () => {
  golden([
    ['выборка полей', q(src(), [{ type: 'select', fields: ['title', 'kind', 'victims'] }])],
    [
      'агрегат с бакетом времени',
      q(src(), [
        {
          type: 'aggregate',
          groupBy: [{ field: 'kind' }, { field: 'occurred_at', bucket: 'month', alias: 'month' }],
          measures: [
            { alias: 'n', agg: 'count' },
            { alias: 'total', agg: 'sum', field: 'damage' },
            { alias: 'mean', agg: 'avg', field: 'victims' },
            { alias: 'p95', agg: 'p95', field: 'response' },
            { alias: 'units', agg: 'count_distinct', field: 'unit_id' },
          ],
        },
        { type: 'sort', by: [{ field: 'n', dir: 'desc' }] },
      ]),
    ],
    [
      'фильтры: список, шаблон, регулярное выражение, множественный выбор',
      q(src(), [
        {
          type: 'filter',
          where: {
            and: [
              { field: 'kind', op: 'in', value: ['fire', 'flood'] },
              { field: 'title', op: 'contains', value: 'склад' },
              { field: 'title', op: 'regex', value: '^A\\d+' },
              { field: 'tags', op: 'in', value: ['крупное', 'ночное'] },
              { field: 'victims', op: 'gt', value: 3 },
            ],
          },
        },
      ]),
    ],
    [
      'выражения: даты, строки, списки',
      q(src(), [
        {
          type: 'compute',
          fields: [
            { name: 'y', expr: 'year(occurred_at)' },
            { name: 'w', expr: "date_trunc('week', occurred_at)" },
            { name: 'later', expr: "date_add(reported_on, 3, 'month')" },
            { name: 'days', expr: "date_diff(reported_on, @today, 'day')" },
            { name: 'label', expr: 'lower(concat(title, kind))' },
            { name: 'ok', expr: "regex_match(kind, '^f')" },
            { name: 'many', expr: "if(victims > 3, 'много', 'мало')" },
          ],
        },
      ]),
    ],
    ['длительность читается минутами', q(src(), [{ type: 'select', fields: ['response'] }])],
  ])
})

describe('DuckDB: политики', () => {
  golden([
    ['строки: политика и барьер', q(src()), policyRows],
    ['строки: ни одной', q(src()), withDatasets({ ...columnar, rowPolicy: { kind: 'none' } })],
    ['столбцы: скрытие и маскирование', q(src()), policyColumns],
    [
      'столбцы: маска не обходится фильтром',
      q(src(), [{ type: 'filter', where: { field: 'phone', op: 'contains', value: '992' } }]),
      policyColumns,
    ],
  ])

  it('политика строк попадает в подзапрос до барьера', () => {
    const compiled = duck(q(src()), policyRows)
    const body = compiled.sql.slice(0, compiled.sql.indexOf('OFFSET 0'))
    expect(body).toContain('"c_7"')
    expect(compiled.sql).toContain('OFFSET 0')
  })

  it('скрытое поле не выбирается ни в каком виде', () => {
    const compiled = duck(q(src()), policyColumns)
    // `notes` — физический столбец c_22 у фикстуры
    const hidden = COLUMNAR_FIELDS.findIndex(([key]) => key === 'notes') + 1
    expect(compiled.sql).not.toContain(`"c_${hidden}"`)
  })

  it('тот же набор столбцов, что и в Postgres', () => {
    const spec = q(src(), [{ type: 'select', fields: ['title', 'kind', 'damage'] }])
    const pg = compileQuery(spec, {
      ...ctx({ datasets: new Map([[columnar.id, columnar]]) }),
      dialect: postgresDialect,
    })
    expect(duck(spec).fields).toEqual(pg.fields)
  })
})

describe('DuckDB: чего в копии нет', () => {
  it('геометрия в результате — ошибка диалекта, а не запроса', () => {
    const spec = q({ kind: 'dataset', id: IDS.incidents }, [{ type: 'select', fields: ['geom'] }])
    expect(() =>
      compileQuery(spec, {
        ...ctx(),
        dialect: duckdbDialect,
        datasets: new Map([[IDS.incidents, incidents]]),
      }),
    ).toThrow(UnsupportedByDialectError)
  })

  it('метрические расчёты по геометрии не поддержаны', () => {
    expect(() => duckdbDialect.geography('"geom"')).toThrow(UnsupportedByDialectError)
    expect(() => duckdbDialect.geoJson('"geom"')).toThrow(UnsupportedByDialectError)
  })
})
