import type { DatasetField, ExplorePlan } from '@kchs/contracts'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { renderWithClient, stubApi } from '~/test/render.js'
import { ExplorePlanEditor } from './explore-builder.js'
import { DrillBar, MapView } from './explore-result.js'

/**
 * «Исследование», следующие шаги ADR-0217: территория уровнем справочника и спуск
 * на уровень ниже, расчёты при сравнении периодов, точки на карте с кластерами.
 */
vi.mock('~/features/gis/index.js', async (original) => ({
  ...(await original<typeof import('~/features/gis/index.js')>()),
  // Карты MapLibre в happy-dom не поднимаются — подменяются подписанными областями
  LazyChoroplethPreview: ({ params }: { params: { level: string } }): ReactNode => (
    <section aria-label={`Хороплет: ${params.level}`} />
  ),
  LazyPointsPreview: ({ field }: { field: string }): ReactNode => (
    <section aria-label={`Точки: ${field}`} />
  ),
}))

function field(
  key: string,
  type: DatasetField['type'],
  label: string,
  extra: Partial<DatasetField> = {},
): DatasetField {
  return {
    id: `field-${key}`,
    key,
    label: { ru: label },
    type,
    semantic: 'dimension',
    required: false,
    ...extra,
  } as DatasetField
}

const fields = [
  field('territory', 'territory', 'Территория'),
  field('occurred_on', 'date', 'Дата'),
  field('victims', 'integer', 'Пострадавшие'),
  field('location', 'geometry', 'Место', { geometryType: 'point' }),
]

const base: ExplorePlan = {
  filter: null,
  groups: [{ field: 'territory' }],
  measures: [{ agg: 'count' }],
  sort: null,
  limit: null,
}

function renderEditor(plan: ExplorePlan) {
  stubApi({})
  const onChange = vi.fn()
  renderWithClient(
    <ExplorePlanEditor fields={fields} plan={plan} onChange={onChange} columnLabel={(n) => n} />,
  )
  return onChange
}

describe('уровень территории', () => {
  it('у разреза-территории выбирается уровень справочника', async () => {
    const user = userEvent.setup()
    const onChange = renderEditor(base)
    await user.click(screen.getByRole('combobox', { name: 'Уровень территории' }))
    await user.click(await screen.findByRole('option', { name: 'Область' }))
    expect(onChange).toHaveBeenLastCalledWith({
      groups: [{ field: 'territory', level: 'region' }],
    })
  })

  it('выбранная единица раскрывается уровнем ниже', async () => {
    const user = userEvent.setup()
    const onDeeper = vi.fn()
    renderWithClient(
      <DrillBar
        value="Хатлон"
        fields={fields}
        exclude={['territory']}
        deeper="district"
        onOnly={() => undefined}
        onSplit={() => undefined}
        onDeeper={onDeeper}
        onRows={() => undefined}
        onClose={() => undefined}
      />,
    )
    await user.click(screen.getByRole('button', { name: 'Уровнем ниже: Районы' }))
    expect(onDeeper).toHaveBeenCalledOnce()
  })
})

describe('расчёты при сравнении периодов', () => {
  it('расчёт доступен и идёт от текущего периода', () => {
    renderEditor({
      ...base,
      measures: [{ agg: 'count', calc: 'share' }],
      compare: {
        field: 'occurred_on',
        current: { from: '2026-01-01', to: '2026-12-31' },
        previous: { from: '2025-01-01', to: '2025-12-31' },
      },
    })
    expect(screen.getByRole('combobox', { name: 'Расчёт' })).toBeEnabled()
    expect(screen.getByText('Расчёт — от значения текущего периода')).toBeVisible()
  })
})

describe('карта результата', () => {
  it('датасет с полем-точкой: точки с кластерами, переключение на территории', async () => {
    const user = userEvent.setup()
    renderWithClient(
      <MapView
        datasetId="00000000-0000-4000-8000-0000000000d1"
        fields={fields}
        plan={{ ...base, groups: [] }}
      />,
    )
    expect(await screen.findByRole('region', { name: 'Точки: location' })).toBeInTheDocument()
    expect(screen.queryByRole('radiogroup', { name: 'Уровень карты' })).toBeNull()
    await user.click(screen.getByRole('radio', { name: 'Территории' }))
    expect(await screen.findByRole('region', { name: 'Хороплет: district' })).toBeInTheDocument()
  })

  it('разрез-территория уровнем: карта открывается на том же уровне', async () => {
    renderWithClient(
      <MapView
        datasetId="00000000-0000-4000-8000-0000000000d1"
        fields={fields}
        plan={{ ...base, groups: [{ field: 'territory', level: 'region' }] }}
      />,
    )
    expect(await screen.findByRole('region', { name: 'Хороплет: region' })).toBeInTheDocument()
  })
})
