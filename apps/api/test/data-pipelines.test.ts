import { sql } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  call,
  createUser,
  db,
  redis,
  registerLifecycle,
  setupFixture,
  type TestContext,
  type TestUser,
} from './helpers.js'

/**
 * Пайплайны преобразований (P5-E03, ADR-0106): определение из шагов
 * компилируется в запрос, прогон материализует новую версию выходного
 * датасета, происхождение показывает узел пайплайна между источником и
 * результатом. Задание выполняется напрямую — как это сделал бы воркер.
 */
registerLifecycle()

const { PipelineService } = await import('../src/modules/data/domain/pipeline-service.js')
const { JobService } = await import('../src/kernel/jobs/service.js')
const { SpaceService } = await import('../src/kernel/spaces/service.js')
const { systemCtx } = await import('../src/shared/context.js')

let fx: TestContext
let analyst: TestUser
let datasetId: string
const run = Date.now().toString(36)

async function createDataset() {
  const created = await call(fx.app, {
    method: 'POST',
    url: '/datasets',
    as: fx.admin,
    payload: {
      name: `Происшествия пайплайна ${run}`,
      spaceId: fx.spaceId,
      fields: [
        { key: 'code', label: { ru: 'Код' }, type: 'identifier', semantic: 'identifier' },
        { key: 'kind', label: { ru: 'Вид' }, type: 'text', semantic: 'category' },
        { key: 'amount', label: { ru: 'Ущерб' }, type: 'number', semantic: 'measure' },
        { key: 'note', label: { ru: 'Заметка' }, type: 'text' },
      ],
    },
  })
  expect(created.statusCode, created.body).toBe(200)
  const id = created.json().id as string
  const rows = await call(fx.app, {
    method: 'POST',
    url: `/datasets/${id}/rows`,
    as: fx.admin,
    payload: {
      rows: [
        { values: { code: 'I-1', kind: 'fire', amount: 100, note: 'центр' } },
        { values: { code: 'I-2', kind: 'fire', amount: 200, note: 'юг' } },
        { values: { code: 'I-3', kind: 'flood', amount: 300, note: 'север' } },
      ],
    },
  })
  expect(rows.statusCode, rows.body).toBe(200)
  return id
}

/** Выполняет задание прогона, как воркер очереди `data`. */
async function runJob(jobId: string) {
  const [row] = await db().execute<{ payload: { pipelineId: string; runId: string } }>(
    sql`SELECT payload FROM jobs WHERE id = ${jobId}`,
  )
  await JobService.start(jobId)
  const result = await PipelineService.execute(row?.payload as never, {
    recordId: jobId,
    progress: async () => undefined,
  })
  await JobService.finish(jobId, result)
  return result
}

const definition = (steps: unknown[], outputName: string) => ({
  version: 1,
  source: { kind: 'dataset', id: datasetId },
  steps,
  outputName,
})

beforeAll(async () => {
  fx = await setupFixture()
  analyst = await createUser(fx.app, 'analyst_pipe', ['employee'])
  await db().transaction((tx) =>
    SpaceService.addMember(tx, systemCtx('test'), fx.spaceId, analyst.id, 'editor'),
  )
  await redis().del(`kchs:principals:${analyst.id}`)
  datasetId = await createDataset()
})

describe('пайплайн: определение, проверка, предпросмотр', () => {
  it('проверка определения возвращает поля результата', async () => {
    const response = await call(fx.app, {
      method: 'POST',
      url: '/pipelines/validate',
      as: analyst,
      payload: {
        definition: definition(
          [
            {
              id: 's1',
              type: 'filter',
              where: { field: 'kind', op: 'eq', value: 'fire' },
            },
            {
              id: 's2',
              type: 'aggregate',
              groupBy: [{ field: 'kind', alias: 'kind' }],
              measures: [{ alias: 'total', agg: 'sum', field: 'amount' }],
            },
          ],
          'Свод',
        ),
      },
    })
    expect(response.statusCode, response.body).toBe(200)
    const result = response.json()
    expect(result.ok).toBe(true)
    expect(result.fields.map((field: { name: string }) => field.name)).toEqual(['kind', 'total'])
  })

  it('ошибка шага называет его идентификатор', async () => {
    const response = await call(fx.app, {
      method: 'POST',
      url: '/pipelines/validate',
      as: analyst,
      payload: {
        definition: definition(
          [{ id: 'bad-step', type: 'rename', renames: [{ field: 'zzz', to: 'x' }] }],
          'Свод',
        ),
      },
    })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json().ok).toBe(false)
    expect(response.json().stepId).toBe('bad-step')
  })

  it('геокодирование и приведение типа компилируются', async () => {
    const response = await call(fx.app, {
      method: 'POST',
      url: '/pipelines/validate',
      as: analyst,
      payload: {
        definition: definition(
          [
            { id: 's1', type: 'cast', casts: [{ field: 'amount', to: 'text' }] },
            {
              id: 's2',
              type: 'geocode',
              field: 'code',
              match: 'code',
              as: 'territory_id',
              pointAs: 'territory_point',
            },
          ],
          'Свод',
        ),
      },
    })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json().ok, response.body).toBe(true)
    const names = response.json().fields.map((field: { name: string }) => field.name)
    expect(names).toContain('territory_id')
    expect(names).toContain('territory_point')
  })

  it('простые шаги компилируются: разбор, склейка, заполнение, дубликаты, столбцы в строки', async () => {
    const validate = async (steps: unknown[]) => {
      const response = await call(fx.app, {
        method: 'POST',
        url: '/pipelines/validate',
        as: analyst,
        payload: { definition: definition(steps, 'Свод') },
      })
      expect(response.statusCode, response.body).toBe(200)
      expect(response.json().ok, response.body).toBe(true)
      return response.json().fields.map((field: { name: string }) => field.name) as string[]
    }

    expect(
      await validate([
        { id: 's1', type: 'split', field: 'note', separator: ' ', into: ['part1'], drop: false },
        { id: 's2', type: 'merge_columns', fields: ['code', 'kind'], into: 'label' },
        { id: 's3', type: 'fill', field: 'note', with: { kind: 'value', value: 'нет' } },
      ]),
    ).toEqual(expect.arrayContaining(['part1', 'label', 'note']))

    expect(await validate([{ id: 'd1', type: 'dedupe', by: ['kind'], keep: 'first' }])).toEqual(
      expect.arrayContaining(['kind', 'code', 'amount']),
    )

    expect(
      await validate([
        {
          id: 'u1',
          type: 'unpivot',
          keep: ['code'],
          fields: ['kind', 'note'],
          nameField: 'metric',
          valueField: 'value',
        },
      ]),
    ).toEqual(['code', 'metric', 'value'])
  })

  it('предпросмотр обрезает цепочку по шагу', async () => {
    const response = await call(fx.app, {
      method: 'POST',
      url: '/pipelines/preview',
      as: analyst,
      payload: {
        definition: definition(
          [
            { id: 's1', type: 'filter', where: { field: 'kind', op: 'eq', value: 'fire' } },
            { id: 's2', type: 'select', fields: [{ field: 'code' }] },
          ],
          'Свод',
        ),
        untilStepId: 's1',
        limit: 10,
      },
    })
    expect(response.statusCode, response.body).toBe(200)
    const result = response.json()
    expect(result.rows).toHaveLength(2)
    expect(result.fields.map((field: { name: string }) => field.name)).toContain('note')
  })

  it('столбцы в строки выполняются, а не только компилируются', async () => {
    const response = await call(fx.app, {
      method: 'POST',
      url: '/pipelines/preview',
      as: analyst,
      payload: {
        definition: definition(
          [
            {
              id: 'u1',
              type: 'unpivot',
              keep: ['code'],
              fields: ['kind', 'note'],
              nameField: 'metric',
              valueField: 'value',
            },
          ],
          'Свод',
        ),
        limit: 50,
      },
    })
    expect(response.statusCode, response.body).toBe(200)
    const result = response.json() as { fields: Array<{ name: string }>; rows: unknown[][] }
    expect(result.fields.map((field) => field.name)).toEqual(['code', 'metric', 'value'])
    // Три строки × два поля
    expect(result.rows).toHaveLength(6)
    expect(result.rows.map((row) => row[1])).toEqual(expect.arrayContaining(['kind', 'note']))
  })
})

describe('пайплайн: прогон и происхождение', () => {
  let pipelineId = ''
  let outputId = ''

  it('создаётся объект реестра и виден в списке', async () => {
    const created = await call(fx.app, {
      method: 'POST',
      url: '/pipelines',
      as: analyst,
      payload: {
        name: `Своды ${run}`,
        spaceId: fx.spaceId,
        definition: definition(
          [
            { id: 's1', type: 'filter', where: { field: 'kind', op: 'eq', value: 'fire' } },
            {
              id: 's2',
              type: 'aggregate',
              groupBy: [{ field: 'kind', alias: 'kind' }],
              measures: [{ alias: 'total', agg: 'sum', field: 'amount' }],
            },
          ],
          `Свод пожаров ${run}`,
        ),
      },
    })
    expect(created.statusCode, created.body).toBe(200)
    pipelineId = created.json().id
    expect(created.json().inputDatasetIds).toContain(datasetId)

    const list = await call(fx.app, { method: 'GET', url: '/pipelines', as: analyst })
    expect(list.statusCode, list.body).toBe(200)
    expect(list.json().items.map((item: { id: string }) => item.id)).toContain(pipelineId)
  })

  it('прогон создаёт датасет-результат с новой версией', async () => {
    const started = await call(fx.app, {
      method: 'POST',
      url: `/pipelines/${pipelineId}/run`,
      as: analyst,
    })
    expect(started.statusCode, started.body).toBe(200)
    const result = await runJob(started.json().jobId)
    expect(result.rows).toBe(1)
    expect(result.created).toBe(true)
    outputId = result.datasetId

    const dataset = await call(fx.app, { method: 'GET', url: `/datasets/${outputId}`, as: analyst })
    expect(dataset.statusCode, dataset.body).toBe(200)
    expect(dataset.json().fields.map((field: { key: string }) => field.key)).toEqual([
      'kind',
      'total',
    ])
    expect(dataset.json().rowCount).toBe(1)

    const versions = await call(fx.app, {
      method: 'GET',
      url: `/datasets/${outputId}/versions`,
      as: analyst,
    })
    expect(versions.statusCode, versions.body).toBe(200)
    expect(versions.json().items[0].origin).toBe('pipeline')
  })

  it('повторный прогон заменяет строки и добавляет версию', async () => {
    const started = await call(fx.app, {
      method: 'POST',
      url: `/pipelines/${pipelineId}/run`,
      as: analyst,
    })
    expect(started.statusCode, started.body).toBe(200)
    const result = await runJob(started.json().jobId)
    expect(result.created).toBe(false)
    expect(result.datasetId).toBe(outputId)
    expect(result.version).toBeGreaterThan(1)

    const runs = await call(fx.app, {
      method: 'GET',
      url: `/pipelines/${pipelineId}/runs`,
      as: analyst,
    })
    expect(runs.statusCode, runs.body).toBe(200)
    expect(runs.json().items).toHaveLength(2)
    expect(runs.json().items[0].status).toBe('succeeded')
  })

  it('узел пайплайна стоит между источником и результатом', async () => {
    const lineage = await call(fx.app, {
      method: 'GET',
      url: `/objects/${outputId}/lineage?depth=3`,
      as: analyst,
    })
    expect(lineage.statusCode, lineage.body).toBe(200)
    const graph = lineage.json() as {
      nodes: Array<{ objectId: string; type: string }>
      edges: Array<{ from: string; to: string }>
    }
    expect(graph.nodes.map((node) => node.objectId)).toContain(pipelineId)
    expect(graph.nodes.find((node) => node.objectId === pipelineId)?.type).toBe('pipeline')
    // Результат ← пайплайн ← входной датасет
    expect(graph.edges).toContainEqual(expect.objectContaining({ from: outputId, to: pipelineId }))
    expect(graph.edges).toContainEqual(expect.objectContaining({ from: pipelineId, to: datasetId }))
  })

  it('посторонний пайплайн не видит', async () => {
    const response = await call(fx.app, {
      method: 'GET',
      url: `/pipelines/${pipelineId}`,
      as: fx.users.stranger,
    })
    expect(response.statusCode).toBe(404)
  })
})
