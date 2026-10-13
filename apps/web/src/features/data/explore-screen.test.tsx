import type { DatasetField, DatasetRecord, QueryResult, QuerySpec } from '@kchs/contracts'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { renderWithClient, stubApi } from '~/test/render.js'
import { DrillBar, pickedRow } from './explore-result.js'
import { ExploreScreen } from './explore-screen.js'

/**
 * «Исследование» для аналитика (ADR-0217): открывается обзором с готовыми
 * вопросами, а не одиноким числом; вопрос строит план и показывает результат;
 * пустой результат объясняется и снимается кнопкой; детализация — из выбранного.
 */
const DATASET = '00000000-0000-4000-8000-0000000000d1'
const SPACE = '00000000-0000-4000-8000-0000000000a1'

function field(key: string, type: DatasetField['type'], label: string): DatasetField {
  return {
    id: `field-${key}`,
    key,
    label: { ru: label },
    type,
    semantic: 'dimension',
    required: false,
  } as DatasetField
}

const fields = [
  field('kind', 'select', 'Вид ЧС'),
  field('occurred_on', 'date', 'Дата'),
  field('victims', 'integer', 'Пострадавшие'),
]

const dataset = {
  id: DATASET,
  name: 'Происшествия',
  description: null,
  kind: 'table',
  spaceId: SPACE,
  parentId: null,
  fields,
  primaryKey: [],
  timeField: 'occurred_on',
  territoryField: null,
  rowCount: 1234,
  currentVersion: 3,
  schemaVersion: 1,
  lastImportAt: '2026-10-01T08:00:00.000Z',
  settings: { editable: true, trackHistory: true, historyRetentionDays: null, rowEvents: false },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-10-01T08:00:00.000Z',
} as unknown as DatasetRecord

const timeProfile = {
  field: 'occurred_on',
  type: 'date',
  version: 3,
  rows: 1234,
  sampled: false,
  empty: 0,
  distinct: 300,
  masked: false,
  min: '2019-03-01',
  max: '2026-09-18',
  mean: null,
  histogram: [],
  top: [],
  computedAt: '2026-10-01T08:00:00.000Z',
}

const empty: QueryResult = {
  fields: [],
  rows: [],
  truncated: false,
  durationMs: 3,
  cached: false,
} as unknown as QueryResult

/** Ответы API экрана; запросы результата — в журнал спецификаций. */
function stubExplore(): QuerySpec[] {
  const specs: QuerySpec[] = []
  stubApi({
    [`/datasets/${DATASET}`]: dataset,
    [`/datasets/${DATASET}/fields/occurred_on/profile`]: timeProfile,
    '/ai/status': { enabled: false },
    'POST /queries/run': ({ init }: { init: RequestInit | undefined }) => {
      specs.push((JSON.parse(String(init?.body)) as { spec: QuerySpec }).spec)
      return empty
    },
  })
  return specs
}

const stepTypes = (spec: QuerySpec | undefined) => spec?.steps.map((step) => step.type)

describe('ExploreScreen', () => {
  it('открывается обзором; вопрос сравнения строит план, пустые периоды объясняются', async () => {
    const user = userEvent.setup()
    const specs = stubExplore()
    renderWithClient(<ExploreScreen datasetId={DATASET} tabId="t1" />)

    expect(await screen.findByRole('heading', { name: 'Обзор датасета' })).toBeVisible()
    expect(screen.getByText(/^1\s234$/)).toBeVisible()
    // Данные кончаются в сентябре 2026 — год сравнения последний полный, 2025-й
    const question = await screen.findByRole('button', {
      name: 'Год 2025 к предыдущему по «Вид ЧС»',
    })
    expect(screen.getByRole('button', { name: 'Динамика по месяцам: «Дата»' })).toBeVisible()
    await user.click(question)

    await waitFor(() =>
      expect(stepTypes(specs.at(-1))).toEqual(['filter', 'aggregate', 'compute', 'sort']),
    )
    expect(await screen.findByText('В периодах сравнения нет строк')).toBeVisible()
    await user.click(
      screen.getAllByRole('button', { name: 'Убрать сравнение' }).at(-1) as HTMLElement,
    )
    // Сортировка по столбцу сравнения снимается вместе со сравнением
    await waitFor(() => expect(stepTypes(specs.at(-1))).toEqual(['aggregate']))
  })

  it('фильтр, отсёкший все строки, объясняется и снимается одной кнопкой', async () => {
    const user = userEvent.setup()
    const specs = stubExplore()
    renderWithClient(
      <ExploreScreen
        datasetId={DATASET}
        tabId="t2"
        savedState={{
          mode: 'result',
          view: 'table',
          explore: {
            datasetId: DATASET,
            filter: { field: 'kind', op: 'eq', value: 'nothing' },
            groups: [{ field: 'kind' }],
            measures: [{ agg: 'count' }],
            sort: null,
            limit: null,
          },
        }}
      />,
    )
    expect(await screen.findByText('Фильтр отсёк все строки')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Убрать фильтр' }))
    await waitFor(() => expect(stepTypes(specs.at(-1))).toEqual(['aggregate']))
  })
})

describe('детализация', () => {
  it('элемент графика находится по подписям; панель предлагает действия', async () => {
    const user = userEvent.setup()
    const labelled = {
      fields: [{ name: 'kind' }, { name: 'count' }],
      rows: [
        ['Пожар', 5],
        ['Паводок', 2],
      ],
    } as unknown as QueryResult
    expect(
      pickedRow(labelled, { label: '', filters: [{ field: 'kind', op: 'eq', value: 'Паводок' }] }),
    ).toBe(1)
    expect(pickedRow(labelled, { label: '', filters: [] })).toBeNull()

    const onOnly = vi.fn()
    const onSplit = vi.fn()
    const onRows = vi.fn()
    renderWithClient(
      <DrillBar
        value="Паводок"
        fields={fields}
        exclude={['kind']}
        onOnly={onOnly}
        onSplit={onSplit}
        onRows={onRows}
        onClose={() => undefined}
      />,
    )
    expect(screen.getByRole('region', { name: 'Выбрано: Паводок' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Оставить только это' }))
    expect(onOnly).toHaveBeenCalledOnce()
    await user.click(screen.getByRole('combobox', { name: 'Разбить по…' }))
    await user.click(await screen.findByRole('option', { name: 'Дата' }))
    expect(onSplit).toHaveBeenCalledWith('occurred_on')
    await user.click(screen.getByRole('button', { name: 'Показать строки' }))
    expect(onRows).toHaveBeenCalledOnce()
  })
})
