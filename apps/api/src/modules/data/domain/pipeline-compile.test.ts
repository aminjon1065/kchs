import type { PipelineDefinition, QueryResultField, QuerySpec } from '@kchs/contracts'
import { describe, expect, it } from 'vitest'
import { compilePipelineSpec, PipelineStepError, pivotAlias } from './pipeline-compile.js'

/**
 * Компилятор пайплайна (ADR-0106): шаги → шаги `QuerySpec`. Схемы датасетов
 * здесь подменены — проверяется именно раскладка шагов, а не выполнение.
 */
const DATASET = '01930000-0000-7000-8000-000000000001'

const fields = (...names: string[]): QueryResultField[] =>
  names.map((name) => ({ name, type: 'text', semantic: null, label: null, format: null }))

const resolver =
  (...names: string[]) =>
  async () =>
    fields(...names)

const definition = (steps: PipelineDefinition['steps']): PipelineDefinition => ({
  version: 1,
  source: { kind: 'dataset', id: DATASET },
  steps,
  outputName: 'Результат',
})

const types = (spec: QuerySpec) => spec.steps.map((step) => step.type)

describe('компилятор пайплайна', () => {
  it('переименование берёт текущие поля и оставляет остальные', async () => {
    const built = await compilePipelineSpec(
      definition([
        { id: 's1', disabled: false, type: 'rename', renames: [{ field: 'a', to: 'alpha' }] },
      ]),
      resolver('a', 'b'),
    )
    expect(types(built.spec)).toEqual(['select'])
    expect(built.spec.steps[0]).toMatchObject({
      type: 'select',
      fields: [{ field: 'a', alias: 'alpha' }, 'b'],
    })
  })

  it('приведение типа — вычисление cast() и возврат имени полю', async () => {
    const built = await compilePipelineSpec(
      definition([
        { id: 's1', disabled: false, type: 'cast', casts: [{ field: 'a', to: 'integer' }] },
      ]),
      resolver('a', 'b'),
    )
    expect(types(built.spec)).toEqual(['compute', 'select'])
    expect(JSON.stringify(built.spec.steps[0])).toContain("cast(a, 'number')")
  })

  it('дубликаты — сортировка и сводка с мерой first', async () => {
    const built = await compilePipelineSpec(
      definition([
        {
          id: 's1',
          disabled: false,
          type: 'dedupe',
          by: ['a'],
          keep: 'last',
          orderBy: [{ field: 'b', dir: 'asc' }],
        },
      ]),
      resolver('a', 'b'),
    )
    expect(types(built.spec)).toEqual(['sort', 'aggregate'])
    expect(built.spec.steps[1]).toMatchObject({
      type: 'aggregate',
      groupBy: [{ field: 'a', alias: 'a' }],
      measures: [{ alias: 'b', agg: 'last', field: 'b' }],
    })
  })

  it('сводная таблица — условные меры по перечисленным значениям', async () => {
    const built = await compilePipelineSpec(
      definition([
        {
          id: 's1',
          disabled: false,
          type: 'pivot',
          groupBy: ['a'],
          column: 'kind',
          values: ['пожар', 'flood'],
          measure: { agg: 'count' },
        },
      ]),
      resolver('a', 'kind'),
    )
    const step = built.spec.steps[0] as { measures: Array<{ alias: string; filter: unknown }> }
    expect(step.measures.map((measure) => measure.alias)).toEqual(['v_1', 'flood'])
    expect(step.measures[0]?.filter).toEqual({ field: 'kind', op: 'eq', value: 'пожар' })
  })

  it('выключенный шаг пропускается, предпросмотр обрезает цепочку', async () => {
    const built = await compilePipelineSpec(
      definition([
        { id: 's1', disabled: true, type: 'select', fields: [{ field: 'a' }] },
        { id: 's2', disabled: false, type: 'select', fields: [{ field: 'b' }] },
        { id: 's3', disabled: false, type: 'select', fields: [{ field: 'c' }] },
      ]),
      resolver('a', 'b', 'c'),
      { untilStepId: 's2' },
    )
    expect(built.spec.steps).toHaveLength(1)
    expect(built.lastStepId).toBe('s2')
  })

  it('свой SQL — только первым и единственным шагом', async () => {
    const one = await compilePipelineSpec(
      definition([{ id: 's1', disabled: false, type: 'custom_sql', sql: 'select 1' }]),
      resolver(),
    )
    expect(one.spec.source).toEqual({ kind: 'sql', sql: 'select 1' })

    await expect(
      compilePipelineSpec(
        definition([
          { id: 's1', disabled: false, type: 'select', fields: [{ field: 'a' }] },
          { id: 's2', disabled: false, type: 'custom_sql', sql: 'select 1' },
        ]),
        resolver('a'),
      ),
    ).rejects.toBeInstanceOf(PipelineStepError)
  })

  it('переименование несуществующего поля — ошибка с номером шага', async () => {
    await expect(
      compilePipelineSpec(
        definition([
          { id: 'step-7', disabled: false, type: 'rename', renames: [{ field: 'zzz', to: 'x' }] },
        ]),
        resolver('a'),
      ),
    ).rejects.toMatchObject({ stepId: 'step-7' })
  })

  it('геокодирование — соединение со справочником территорий', async () => {
    const built = await compilePipelineSpec(
      definition([
        {
          id: 's1',
          disabled: false,
          type: 'geocode',
          field: 'code',
          match: 'code',
          as: 'territory_id',
        },
      ]),
      resolver('code'),
    )
    expect(types(built.spec)).toEqual(['join', 'compute'])
    expect(built.spec.steps[0]).toMatchObject({
      type: 'join',
      source: { kind: 'system', name: 'territories' },
    })
  })
})

describe('имя столбца сводной таблицы', () => {
  it('латиница остаётся, прочее — по номеру', () => {
    expect(pivotAlias('Fire', 0)).toBe('fire')
    expect(pivotAlias('пожар', 3)).toBe('v_4')
  })
})
