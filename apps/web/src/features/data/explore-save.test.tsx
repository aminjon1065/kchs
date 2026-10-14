import { type ExplorePlan, explorePlanSpec } from '@kchs/contracts'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { renderWithClient, stubApi } from '~/test/render.js'
import { ExploreSaveMenu } from './explore-save.js'

/**
 * «Исследование» датасетом и показателем (ADR-0217, «Дополнено»): пайплайн из шагов
 * плана с первым прогоном; показатель из выбранной меры. Что не переносится — сказано.
 */
const DATASET = '00000000-0000-4000-8000-0000000000d1'
const SPACE = '00000000-0000-4000-8000-0000000000a1'
const PIPELINE = '00000000-0000-4000-8000-0000000000e1'
const METRIC = '00000000-0000-4000-8000-0000000000f1'

const plan: ExplorePlan = {
  filter: { field: 'kind', op: 'eq', value: 'flood' },
  groups: [{ field: 'territory', level: 'region' }],
  measures: [
    { agg: 'count', calc: 'share' },
    { agg: 'sum', field: 'victims' },
  ],
  sort: { field: 'count', dir: 'desc' },
  limit: 10,
}

const labels: Record<string, string> = { count: 'Количество', sum_victims: 'Сумма: Пострадавшие' }

function renderMenu(current: ExplorePlan = plan) {
  renderWithClient(
    <ExploreSaveMenu
      datasetId={DATASET}
      spaceId={SPACE}
      name="Происшествия"
      plan={current}
      view="table"
      chartType={null}
      chartSpec={null}
      spec={explorePlanSpec(DATASET, current)}
      columnLabel={(name) => labels[name] ?? name}
    />,
  )
}

describe('ExploreSaveMenu', () => {
  it('«Как датасет…»: пайплайн из шагов плана и его прогон; потери названы', async () => {
    const user = userEvent.setup()
    const calls = stubApi({
      'POST /pipelines': { id: PIPELINE, name: 'Паводки по областям' },
      [`POST /pipelines/${PIPELINE}/run`]: { id: 'run-1', status: 'queued' },
    })
    renderMenu()
    await user.click(screen.getByRole('button', { name: 'Ещё действия' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Как датасет…' }))
    const dialog = await screen.findByRole('dialog', { name: 'Сохранить как датасет' })
    expect(dialog).toHaveTextContent('Расчёты над мерами в датасет не попадают')
    expect(dialog).toHaveTextContent('Сортировка и лимит не переносятся')
    const name = screen.getByRole('textbox', { name: 'Название' })
    await user.clear(name)
    await user.type(name, 'Паводки по областям')
    await user.click(screen.getByRole('button', { name: 'Создать' }))

    await waitFor(() =>
      expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
        'POST /pipelines',
        `POST /pipelines/${PIPELINE}/run`,
      ]),
    )
    const body = calls[0]?.body as {
      name: string
      spaceId: string
      definition: { outputName: string; steps: Array<{ id: string; type: string }> }
    }
    expect(body.name).toBe('Паводки по областям')
    expect(body.spaceId).toBe(SPACE)
    expect(body.definition.outputName).toBe('Паводки по областям')
    expect(body.definition.steps.map((step) => step.type)).toEqual([
      'filter',
      'compute',
      'aggregate',
    ])
  })

  it('«Как показатель…»: выбранная мера, фильтр — условия, разрезы — допустимые разрезы', async () => {
    const user = userEvent.setup()
    const calls = stubApi({ 'POST /metrics': { id: METRIC } })
    renderMenu()
    await user.click(screen.getByRole('button', { name: 'Ещё действия' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Как показатель…' }))
    await screen.findByRole('dialog', { name: 'Сохранить как показатель' })
    expect(screen.getByRole('textbox', { name: 'Название' })).toHaveValue(
      'Происшествия — Количество',
    )
    await user.click(screen.getByRole('combobox', { name: 'Мера' }))
    await user.click(await screen.findByRole('option', { name: 'Сумма: Пострадавшие' }))
    await user.click(screen.getByRole('button', { name: 'Создать' }))

    await waitFor(() => expect(calls.some((call) => call.path === '/metrics')).toBe(true))
    const body = calls.find((call) => call.path === '/metrics')?.body as {
      datasetId: string
      definition: { measure: unknown; filter: unknown; dimensions: string[] }
    }
    expect(body.datasetId).toBe(DATASET)
    expect(body.definition.measure).toEqual({ agg: 'sum', field: 'victims' })
    expect(body.definition.filter).toEqual(plan.filter)
    expect(body.definition.dimensions).toEqual(['territory'])
  })

  it('без мер показатель не из чего сделать — пункт недоступен', async () => {
    const user = userEvent.setup()
    stubApi({})
    renderMenu({ ...plan, groups: [], measures: [] })
    await user.click(screen.getByRole('button', { name: 'Ещё действия' }))
    expect(await screen.findByRole('menuitem', { name: 'Как показатель…' })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
  })
})
