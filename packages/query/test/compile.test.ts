import type { QuerySpec } from '@kchs/contracts'
import { describe, expect, it } from 'vitest'
import {
  cacheKeyText,
  checkExpression,
  collectSources,
  compileQuery,
  DEFAULT_MAX_ROWS,
  DEFAULT_TIMEOUT_MS,
  MissingReferencesError,
  type ReferenceMap,
  type ReferenceRequest,
  referenceKey,
} from '../src/index.js'
import {
  ctx,
  IDS,
  incidents,
  NOW,
  q,
  src,
  TERR_DU,
  TERR_DU_1,
  TERR_DU_2,
  USER_ID,
  withDatasets,
} from './fixtures.js'

const regionsSource = { kind: 'dataset', id: IDS.regions, alias: 'reg' } as const

describe('collectSources', () => {
  it('основной источник, соединения, объединения, системные, SQL', () => {
    const spec = q(src('inc'), [
      {
        type: 'join',
        source: regionsSource,
        on: [{ left: 'inc.territory_id', right: 'reg.territory_id' }],
        kind: 'left',
      },
      { type: 'union', source: { kind: 'system', name: 'tasks' }, mode: 'all' },
      { type: 'union', source: { kind: 'sql', sql: 'select 1' }, mode: 'all' },
      {
        type: 'join',
        source: { kind: 'dataset', id: IDS.regions, alias: 'r2' },
        on: [{ left: 'a', right: 'b' }],
        kind: 'left',
      },
    ])
    expect(collectSources(spec)).toEqual({
      datasets: [IDS.incidents, IDS.regions],
      queries: [],
      system: ['tasks'],
      sql: true,
    })
  })

  it('сохранённые запросы обходятся рекурсивно, если загружены', () => {
    const inner = q({ kind: 'dataset', id: IDS.archive })
    const outer = q({ kind: 'query', id: IDS.savedTotals }, [
      {
        type: 'join',
        source: { kind: 'query', id: IDS.savedNested },
        on: [{ left: 'a', right: 'b' }],
        kind: 'left',
      },
    ])
    expect(collectSources(outer)).toEqual({
      datasets: [],
      queries: [IDS.savedTotals, IDS.savedNested],
      system: [],
      sql: false,
    })
    expect(collectSources(outer, new Map([[IDS.savedTotals, inner]])).datasets).toEqual([
      IDS.archive,
    ])
  })

  it('цикл сохранённых запросов не зацикливает обход', () => {
    const loop = q({ kind: 'query', id: IDS.savedLoop })
    expect(collectSources(loop, new Map([[IDS.savedLoop, loop]])).queries).toEqual([IDS.savedLoop])
  })
})

describe('результат компиляции', () => {
  it('предел строк, тайм-аут по умолчанию и из контекста', () => {
    const compiled = compileQuery(q(src()), ctx())
    expect(compiled.maxRows).toBe(DEFAULT_MAX_ROWS)
    expect(compiled.timeoutMs).toBe(DEFAULT_TIMEOUT_MS)
    expect(compiled.sql.endsWith(`LIMIT ${DEFAULT_MAX_ROWS + 1}`)).toBe(true)
    expect(compileQuery(q(src()), ctx({ defaultTimeoutMs: 600_000 })).timeoutMs).toBe(600_000)
    const spec = q(src(), [], {}, { timeoutMs: 1234, cache: true, approxCount: true })
    expect(compileQuery(spec, ctx({ defaultTimeoutMs: 600_000 })).timeoutMs).toBe(1234)
    expect(compileQuery(q(src()), ctx({ maxRows: null })).maxRows).toBeNull()
  })

  it('геометрия — GeoJSON по умолчанию, как есть — для тайлов; режим входит в ключ кэша', () => {
    const spec = q(src(), [{ type: 'select', fields: ['geom'] }])
    const json = compileQuery(spec, ctx())
    expect(json.sql).toMatch(/ST_AsGeoJSON\(/)
    expect(json.cacheKeyParts).not.toHaveProperty('geometryOutput')
    const raw = compileQuery(spec, ctx({ geometryOutput: 'raw' }))
    expect(raw.sql).not.toMatch(/ST_AsGeoJSON\(/)
    expect(raw.cacheKeyParts.geometryOutput).toBe('raw')
  })

  it('пространственное окно: рамка рядом с политикой строк, до барьера; в ключе кэша', () => {
    const window = {
      datasetId: IDS.incidents,
      field: 'geom',
      bbox: [68, 37, 70, 39] as const,
    }
    const spec = q(src(), [
      { type: 'filter', where: { field: 'kind', op: 'eq', value: 'fire' } },
      { type: 'select', fields: ['geom', 'kind'] },
    ])
    const restricted = {
      ...incidents,
      rowPolicy: {
        kind: 'filter' as const,
        where: { field: 'title', op: 'eq' as const, value: 'DU' },
      },
    }
    const compiled = compileQuery(
      spec,
      ctx({ ...withDatasets(restricted), spatialWindow: window, geometryOutput: 'raw' }),
    )
    // Базовый подзапрос: удалённые, политика, окно — и только потом барьер
    const base = /"q0" AS \(([\s\S]*?)\n\)/.exec(compiled.sql)?.[1] ?? ''
    expect(base).toMatch(
      / && ST_MakeEnvelope\(\$\d+::float8, \$\d+::float8, \$\d+::float8, \$\d+::float8, 4326\)/,
    )
    expect(base.indexOf('ST_MakeEnvelope')).toBeLessThan(base.indexOf('OFFSET 0'))
    // Условие пользователя — после барьера, не в базовом подзапросе
    expect(base).not.toMatch(/fire|"kind" =/)
    expect(compiled.params).toEqual(expect.arrayContaining([68, 37, 70, 39]))
    expect(compiled.cacheKeyParts.spatialWindow).toEqual({
      datasetId: IDS.incidents,
      field: 'geom',
      bbox: [68, 37, 70, 39],
    })
    // Без окна ключ прежний, другое окно — другой ключ
    const plain = compileQuery(spec, ctx({ ...withDatasets(restricted), geometryOutput: 'raw' }))
    expect(plain.cacheKeyParts).not.toHaveProperty('spatialWindow')
    const other = compileQuery(
      spec,
      ctx({
        ...withDatasets(restricted),
        spatialWindow: { ...window, bbox: [70, 37, 72, 39] },
        geometryOutput: 'raw',
      }),
    )
    expect(cacheKeyText(other.cacheKeyParts)).not.toBe(cacheKeyText(compiled.cacheKeyParts))

    // Окно другого датасета не трогает этот; маскированная геометрия — ничего в окне
    const foreign = compileQuery(
      spec,
      ctx({ spatialWindow: { ...window, datasetId: IDS.regions } }),
    )
    expect(foreign.sql).not.toMatch(/ST_MakeEnvelope/)
    const masked = compileQuery(
      spec,
      ctx({
        ...withDatasets({ ...incidents, columnPolicy: { hide: [], mask: ['geom'] } }),
        spatialWindow: window,
      }),
    )
    expect(masked.sql).toMatch(/IS NULL AND FALSE/)
    // Скрытое поле и не геометрия — ошибка компиляции
    expect(() =>
      compileQuery(
        q(src(), [{ type: 'select', fields: ['kind'] }]),
        ctx({
          ...withDatasets({ ...incidents, columnPolicy: { hide: ['geom'], mask: [] } }),
          spatialWindow: window,
        }),
      ),
    ).toThrow(/нет видимого поля геометрии/)
    expect(() => compileQuery(spec, ctx({ spatialWindow: { ...window, field: 'kind' } }))).toThrow(
      /нет видимого поля геометрии/,
    )
    expect(() =>
      compileQuery(spec, ctx({ spatialWindow: { ...window, bbox: [70, 37, 68, 39] } })),
    ).toThrow(/рамка/)
  })

  it('поля результата: подпись, формат, семантика из схемы', () => {
    const withMeta = {
      ...incidents,
      fields: incidents.fields.map((field) =>
        field.key === 'damage'
          ? {
              ...field,
              label: { ru: 'Ущерб', en: 'Damage' },
              semantic: 'measure' as const,
              format: { precision: 2 },
            }
          : field,
      ),
    }
    const compiled = compileQuery(
      q(src(), [{ type: 'select', fields: ['damage', 'reported_on'] }]),
      ctx({ ...withDatasets(withMeta), rowMeta: true }),
    )
    expect(compiled.fields).toEqual([
      { name: '_id', type: 'integer', semantic: 'system', label: null, format: null },
      { name: '_ver', type: 'integer', semantic: 'system', label: null, format: null },
      {
        name: 'damage',
        type: 'money',
        semantic: 'measure',
        label: { ru: 'Ущерб', en: 'Damage' },
        format: { precision: 2 },
      },
      {
        name: 'reported_on',
        type: 'date',
        semantic: 'time',
        label: { ru: 'reported_on' },
        format: null,
      },
    ])
  })

  it('поля мер и вычислений', () => {
    const compiled = compileQuery(
      q(src(), [
        {
          type: 'aggregate',
          groupBy: [{ field: 'occurred_at', bucket: 'month', alias: 'month' }],
          measures: [
            { alias: 'n', agg: 'count' },
            { alias: 'avg_victims', agg: 'avg', field: 'victims' },
          ],
        },
        { type: 'compute', fields: [{ name: 'label', expr: "format_date(month, 'MM.YYYY')" }] },
      ]),
      ctx(),
    )
    expect(compiled.fields).toEqual([
      { name: 'month', type: 'date', semantic: 'time', label: { ru: 'occurred_at' }, format: null },
      { name: 'n', type: 'integer', semantic: 'measure', label: null, format: null },
      { name: 'avg_victims', type: 'number', semantic: 'measure', label: null, format: null },
      { name: 'label', type: 'text', semantic: 'dimension', label: null, format: null },
    ])
  })

  it('подсчёт без завершающих сортировки, лимита и проекций, со своими параметрами', () => {
    const compiled = compileQuery(
      q(src(), [
        { type: 'filter', where: { field: 'kind', op: 'eq', value: 'fire' } },
        { type: 'sort', by: [{ field: 'damage', dir: 'desc' }] },
        { type: 'limit', limit: 10, offset: 0 },
        { type: 'compute', fields: [{ name: 'x', expr: "title || '!'" }] },
        { type: 'select', fields: ['x'] },
      ]),
      ctx(),
    )
    expect(compiled.params).toEqual(['fire', '!'])
    expect(compiled.countParams).toEqual(['fire'])
    expect(compiled.countSql).toContain('WHERE ("q0"."kind" = $1::text)')
    expect(compiled.countSql).not.toContain('LIMIT')
    expect(compiled.countSql.endsWith('SELECT count(*) AS "count"\nFROM "q1"')).toBe(true)
  })

  it('лимит в середине конвейера учитывается в подсчёте', () => {
    const compiled = compileQuery(
      q(src(), [
        { type: 'limit', limit: 10, offset: 0 },
        { type: 'filter', where: { field: 'kind', op: 'eq', value: 'fire' } },
      ]),
      ctx(),
    )
    expect(compiled.countSql).toContain('LIMIT 10')
  })
})

describe('ключ кэша', () => {
  const base = q(src(), [{ type: 'filter', where: { field: 'kind', op: 'eq', value: 'fire' } }])

  it('состав: спецификация, версии датасетов, политика, пояс, режим', () => {
    const parts = compileQuery(base, ctx()).cacheKeyParts
    expect(parts.datasets).toEqual([
      { id: IDS.incidents, version: 7, policy: '{"hide":[],"mask":[],"row":{"kind":"all"}}' },
    ])
    expect(parts.queries).toEqual([])
    expect(parts.params).toEqual({})
    expect(parts.user).toEqual({})
    expect(parts.time).toBeNull()
    expect(parts.timezone).toBe('Asia/Dushanbe')
    expect(parts.maxRows).toBe(DEFAULT_MAX_ROWS)
    expect(parts.rowMeta).toBe(false)
    expect(parts.references).toEqual([])
  })

  it('строка ключа — канонический JSON частей', () => {
    const parts = compileQuery(base, ctx()).cacheKeyParts
    const text = cacheKeyText(parts)
    expect(JSON.parse(text)).toEqual(parts)
    expect(cacheKeyText({ ...parts })).toBe(text)
    expect(text.indexOf('"datasets"')).toBeLessThan(text.indexOf('"spec"'))
  })

  it('порядок ключей спецификации не влияет', () => {
    const reordered = JSON.parse(
      JSON.stringify({
        steps: base.steps,
        options: base.options,
        params: base.params,
        source: base.source,
        version: 1,
      }),
    ) as QuerySpec
    expect(compileQuery(reordered, ctx()).cacheKeyParts.spec).toBe(
      compileQuery(base, ctx()).cacheKeyParts.spec,
    )
  })

  it('версия датасета и политика меняют ключ', () => {
    const parts = compileQuery(base, ctx()).cacheKeyParts
    const newer = compileQuery(base, ctx(withDatasets({ ...incidents, version: 8 }))).cacheKeyParts
    const masked = compileQuery(
      base,
      ctx(withDatasets({ ...incidents, columnPolicy: { hide: [], mask: ['title'] } })),
    ).cacheKeyParts
    expect(newer.datasets[0]?.version).toBe(8)
    expect(masked.datasets[0]?.policy).not.toBe(parts.datasets[0]?.policy)
  })

  it('время — только если запрос от него зависит, с точностью до минуты', () => {
    const relative = q(src(), [
      {
        type: 'filter',
        where: { field: 'reported_on', op: 'relative', value: { unit: 'day', from: -1, to: 0 } },
      },
    ])
    expect(compileQuery(relative, ctx()).cacheKeyParts.time).toBe('2026-09-18T07:30')
    const today = q(src(), [{ type: 'compute', fields: [{ name: 't', expr: 'today()' }] }])
    expect(compileQuery(today, ctx()).cacheKeyParts.time).toBe(NOW.toISOString().slice(0, 16))
  })

  it('только использованные параметры и значения пользователя', () => {
    const spec = q(
      src(),
      [
        { type: 'filter', where: { field: 'kind', op: 'eq', value: '@param:kind' } },
        { type: 'filter', where: { field: 'assignee', op: 'is_me' } },
      ],
      { kind: { type: 'text' }, unused: { type: 'number', default: 5 } },
    )
    const parts = compileQuery(spec, ctx({ params: { kind: 'fire', other: 1 } })).cacheKeyParts
    expect(parts.params).toEqual({ kind: 'fire' })
    expect(parts.user).toEqual({ id: USER_ID })
  })

  it('атрибуты пользователя из политики строк', () => {
    const parts = compileQuery(
      q(src()),
      ctx(
        withDatasets({
          ...incidents,
          rowPolicy: { kind: 'expr', expr: "kind in (user_attr('territory_codes'))" },
        }),
      ),
    ).cacheKeyParts
    expect(parts.user).toEqual({ attributes: { territory_codes: ['DU', 'KH'] } })
  })

  it('сохранённые запросы-источники', () => {
    const saved = q(src(), [{ type: 'limit', limit: 3, offset: 0 }])
    const parts = compileQuery(
      q({ kind: 'query', id: IDS.savedTotals }),
      ctx({ queries: new Map([[IDS.savedTotals, saved]]) }),
    ).cacheKeyParts
    expect(parts.queries).toHaveLength(1)
    expect(parts.queries[0]?.id).toBe(IDS.savedTotals)
    expect(parts.queries[0]?.spec).toContain('"limit":3')
  })
})

describe('справочные подстановки (ADR-0057)', () => {
  const byRegion = q(src(), [
    {
      type: 'compute',
      fields: [{ name: 'region', expr: "territory_level(territory_id, 'region')" }],
    },
    { type: 'aggregate', groupBy: [{ field: 'region' }], measures: [{ alias: 'n', agg: 'count' }] },
  ])
  const references =
    (maps: Record<string, ReferenceMap>) =>
    (request: ReferenceRequest): ReferenceMap | undefined =>
      maps[referenceKey(request)]

  it('нет подстановки — MissingReferencesError с тем, что загрузить', () => {
    let error: unknown
    try {
      compileQuery(byRegion, ctx())
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(MissingReferencesError)
    expect((error as MissingReferencesError).requests).toEqual([
      { kind: 'territory_level', level: 'region', key: 'id' },
    ])
  })

  it('подстановка — один параметр jsonb, версия — в ключе кэша, предок — территория', () => {
    const values = { [TERR_DU_1]: TERR_DU, [TERR_DU_2]: TERR_DU }
    const compiled = compileQuery(
      byRegion,
      ctx({
        references: references({ 'territory_level:id:region': { values, version: 'v1' } }),
      }),
    )
    expect(compiled.params.filter((param) => param === JSON.stringify(values))).toHaveLength(1)
    expect(compiled.cacheKeyParts.references).toEqual([
      { key: 'territory_level:id:region', version: 'v1' },
    ])
    expect(compiled.fields.map((field) => [field.name, field.type])).toEqual([
      ['region', 'territory'],
      ['n', 'integer'],
    ])
  })

  it('поле со справочником: lookup_label по ссылке поля', () => {
    const withLookup = {
      ...incidents,
      fields: incidents.fields.map((field) =>
        field.key === 'kind'
          ? { ...field, lookup: { datasetId: IDS.regions, keyField: 'name', labelField: 'name' } }
          : field,
      ),
    }
    const spec = q(src(), [
      { type: 'compute', fields: [{ name: 'kind_label', expr: 'lookup_label(kind)' }] },
    ])
    let error: unknown
    try {
      compileQuery(spec, ctx(withDatasets(withLookup)))
    } catch (caught) {
      error = caught
    }
    expect((error as MissingReferencesError).requests).toEqual([
      { kind: 'lookup_label', datasetId: IDS.regions, keyField: 'name', labelField: 'name' },
    ])
  })
})

describe('параметры согласованы с текстом SQL', () => {
  it('отброшенная группа условий не оставляет параметров', () => {
    const compiled = compileQuery(
      q(
        src(),
        [
          {
            type: 'filter',
            where: {
              and: [
                { field: 'title', op: 'eq', value: 'x' },
                {
                  or: [
                    {
                      field: 'reported_on',
                      op: 'relative',
                      value: { unit: 'day', from: -1, to: 0 },
                    },
                    { field: 'kind', op: 'eq', value: '@param:kind' },
                  ],
                },
                { field: 'occurred_at', op: 'eq', value: '2026-09-01' },
              ],
            },
          },
        ],
        { kind: { type: 'text' } },
      ),
      ctx(),
    )
    // Пояс переиспользуется после отката: он снова получает свой номер
    expect(compiled.params).toEqual(['x', '2026-09-01', 'Asia/Dushanbe', '2026-09-02'])
    expect(compiled.sql).toContain(
      'WHERE (("q0"."title" = $1::text) AND ("q0"."occurred_at" >= ($2::timestamp AT TIME ZONE $3::text) AND "q0"."occurred_at" < ($4::timestamp AT TIME ZONE $3::text)))',
    )
    expect(compiled.cacheKeyParts.time).toBe('2026-09-18T07:30')
  })
})

describe('checkExpression', () => {
  const fields = [
    { key: 'amount', type: 'money' as const },
    { key: 'title', type: 'text' as const },
    { key: 'score', type: 'formula' as const },
  ]

  it('тип результата и тип поля', () => {
    expect(checkExpression('amount * 2', { fields })).toEqual({
      ok: true,
      type: 'number',
      fieldType: 'number',
      aggregate: false,
    })
    expect(checkExpression('amount', { fields })).toMatchObject({ ok: true, fieldType: 'money' })
    expect(checkExpression('sum(amount)', { fields, mode: 'aggregate' })).toMatchObject({
      ok: true,
      aggregate: true,
    })
  })

  it('ошибка с позицией и подсказкой', () => {
    expect(checkExpression('amount + title', { fields })).toEqual({
      ok: false,
      issue: {
        path: [],
        message: 'Оператор «+» применим только к числам, а получено: строка',
        position: 9,
      },
    })
    expect(checkExpression('count()', { fields })).toMatchObject({
      ok: false,
      issue: { hint: 'Добавьте шаг «Сводка» (aggregate) и опишите меру там' },
    })
  })

  it('условие, параметры, макросы, вычисляемые поля', () => {
    expect(checkExpression('amount', { fields, condition: true })).toMatchObject({ ok: false })
    expect(
      checkExpression('amount > @param:limit', { fields, params: { limit: 'number' } }),
    ).toMatchObject({
      ok: true,
      type: 'boolean',
    })
    expect(checkExpression('@param:x', { fields })).toMatchObject({
      ok: false,
      issue: { message: 'Неизвестный параметр «x»' },
    })
    expect(checkExpression('@me = title', { fields, condition: true })).toMatchObject({ ok: true })
    expect(checkExpression('@my_units', { fields })).toMatchObject({
      ok: false,
      issue: { message: 'Список значений допустим только внутри in (…)', position: 0 },
    })
    expect(checkExpression('score > 1', { fields })).toMatchObject({
      ok: false,
      issue: { message: 'Поле «score» вычисляемое — в выражении недоступно' },
    })
    expect(
      checkExpression('title || count()', { fields, mode: 'aggregate', groupBy: ['title'] }),
    ).toMatchObject({
      ok: true,
    })
  })
})
