import type { ChartSpec, QueryResult } from '@kchs/contracts'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { getInstanceByDom } from 'echarts/core'
import type { ReactNode } from 'react'
import { expect, fn, userEvent, waitFor, within } from 'storybook/test'
import { Card } from '../components/data-display.js'
import {
  ARRIVAL,
  BY_DISTRICT,
  BY_KIND,
  BY_MONTH,
  BY_MONTH_REGION,
  chartSpec,
  DAMAGE_TREE,
  DISTRICT_MONTH,
  GAUGES,
  KPI,
  PIPELINE,
  queryResult,
  READINESS,
  REGIONS,
} from '../stories/chart-data.js'
import { Chart } from './chart.js'
import { NumberTile } from './number-tile.js'

const meta = {
  title: 'Графики/Типы',
  id: 'charts',
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

/** Снимок — после того как все графики на странице отрисованы (событие finished ECharts). */
async function chartsReady({ canvasElement }: { canvasElement: HTMLElement }): Promise<void> {
  await waitFor(
    () => {
      const charts = [...canvasElement.querySelectorAll('[data-chart-state]')]
      expect(charts.length).toBeGreaterThan(0)
      for (const chart of charts) expect(chart.getAttribute('data-chart-state')).toBe('ready')
    },
    { timeout: 15_000 },
  )
}

function Frame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="w-[720px]">
      <Card title={title}>{children}</Card>
    </div>
  )
}

function Example({
  title,
  spec,
  result,
  height,
}: {
  title: string
  spec: ChartSpec
  result: QueryResult
  height?: number
}) {
  return (
    <Frame title={title}>
      <Chart spec={spec} result={result} height={height} animation={false} colorDomain={REGIONS} />
    </Frame>
  )
}

const month = { field: 'month', type: 'temporal' } as const
const incidents = { field: 'incidents', type: 'quantitative' } as const
const region = { field: 'region', type: 'nominal', palette: 'categorical' } as const
const district = { field: 'district', type: 'nominal' } as const

export const Bar: Story = {
  name: 'Столбцы: по убыванию, подписи значений',
  render: () => (
    <Example
      title="Происшествия по районам"
      spec={chartSpec({
        type: 'bar',
        encoding: { x: district, y: [incidents] },
        options: { sort: { by: 'incidents', dir: 'desc' } },
      })}
      result={BY_DISTRICT}
    />
  ),
  play: chartsReady,
}

export const BarStacked: Story = {
  name: 'Столбцы: стопка по регионам',
  render: () => (
    <Example
      title="Происшествия по месяцам"
      spec={chartSpec({
        type: 'bar',
        encoding: { x: month, y: [incidents], color: region },
        options: { stacked: true },
      })}
      result={BY_MONTH_REGION}
    />
  ),
  play: chartsReady,
}

export const BarPercent: Story = {
  name: 'Столбцы: доли регионов',
  render: () => (
    <Example
      title="Доля регионов в происшествиях"
      spec={chartSpec({
        type: 'bar',
        encoding: { x: month, y: [incidents], color: region },
        options: { percent: true },
      })}
      result={BY_MONTH_REGION}
    />
  ),
  play: chartsReady,
}

export const BarHorizontal: Story = {
  name: 'Столбцы: горизонтальные, пять крупнейших и «Прочее»',
  render: () => (
    <Example
      title="Ущерб по районам"
      spec={chartSpec({
        type: 'bar',
        encoding: {
          x: district,
          y: [{ field: 'damage', type: 'quantitative' }],
        },
        options: { horizontal: true, limit: 5, other: true, sort: { by: 'damage', dir: 'desc' } },
      })}
      result={BY_DISTRICT}
    />
  ),
  play: chartsReady,
}

export const Line: Story = {
  name: 'Линии: три региона, порог и аннотация',
  render: () => (
    <Example
      title="Происшествия по регионам"
      spec={chartSpec({
        type: 'line',
        encoding: { x: month, y: [incidents], color: region },
        options: {
          referenceLines: [{ axis: 'y', value: 60, label: 'Порог реагирования' }],
          annotations: [{ x: '2026-04-01', text: 'Начало паводка' }],
        },
      })}
      result={BY_MONTH_REGION}
    />
  ),
  play: chartsReady,
}

export const LineComparison: Story = {
  name: 'Линия: сравнение с прошлым периодом',
  render: () => (
    <Example
      title="Происшествия, всего"
      spec={chartSpec({
        type: 'line',
        encoding: { x: month, y: [incidents] },
        options: { comparison: { mode: 'previous_period' }, smooth: true },
      })}
      result={BY_MONTH}
    />
  ),
  play: chartsReady,
}

export const Area: Story = {
  name: 'Области: стопка',
  render: () => (
    <Example
      title="Происшествия по регионам"
      spec={chartSpec({
        type: 'area',
        encoding: { x: month, y: [incidents], color: region },
        options: { stacked: true },
      })}
      result={BY_MONTH_REGION}
    />
  ),
  play: chartsReady,
}

export const Pie: Story = {
  name: 'Круговая',
  render: () => (
    <Example
      title="Виды происшествий"
      spec={chartSpec({
        type: 'pie',
        encoding: { x: { field: 'kind', type: 'nominal' }, y: [incidents] },
      })}
      result={BY_KIND}
    />
  ),
  play: chartsReady,
}

export const Donut: Story = {
  name: 'Кольцевая: итог в центре',
  render: () => (
    <Example
      title="Виды происшествий"
      spec={chartSpec({
        type: 'donut',
        encoding: { x: { field: 'kind', type: 'nominal' }, y: [incidents] },
      })}
      result={BY_KIND}
    />
  ),
  play: chartsReady,
}

export const Scatter: Story = {
  name: 'Точечная: три реки и «Прочее»',
  render: () => (
    <Example
      title="Уровень и расход на постах"
      spec={chartSpec({
        type: 'scatter',
        encoding: {
          x: { field: 'flow', type: 'quantitative' },
          y: [{ field: 'level', type: 'quantitative' }],
          color: { field: 'river', type: 'nominal' },
          text: { field: 'post', type: 'nominal' },
        },
      })}
      result={GAUGES}
    />
  ),
  play: chartsReady,
}

export const Bubble: Story = {
  name: 'Пузырьковая: население в зоне',
  render: () => (
    <Example
      title="Посты: уровень, расход и население"
      spec={chartSpec({
        type: 'bubble',
        encoding: {
          x: { field: 'flow', type: 'quantitative' },
          y: [{ field: 'level', type: 'quantitative' }],
          size: { field: 'population', type: 'quantitative' },
          text: { field: 'post', type: 'nominal' },
        },
      })}
      result={GAUGES}
    />
  ),
  play: chartsReady,
}

export const Heatmap: Story = {
  name: 'Тепловая карта: районы по месяцам',
  render: () => (
    <Example
      title="Происшествия по районам и месяцам"
      spec={chartSpec({
        type: 'heatmap',
        encoding: {
          x: month,
          y: [{ field: 'district', type: 'nominal' }],
          color: { field: 'incidents', type: 'quantitative', palette: 'sequential' },
        },
      })}
      result={DISTRICT_MONTH}
      height={300}
    />
  ),
  play: chartsReady,
}

export const Histogram: Story = {
  name: 'Гистограмма: время прибытия',
  render: () => (
    <Example
      title="Время прибытия расчётов"
      spec={chartSpec({
        type: 'histogram',
        encoding: { x: { field: 'minutes', type: 'quantitative' } },
        options: {
          referenceLines: [{ axis: 'x', value: 20, label: 'Норматив', color: 'warning' }],
        },
      })}
      result={ARRIVAL}
    />
  ),
  play: chartsReady,
}

export const Combo: Story = {
  name: 'Комбинированный: две оси с именами',
  render: () => (
    <Example
      title="Происшествия и ущерб по районам"
      spec={chartSpec({
        type: 'combo',
        encoding: {
          x: district,
          y: [
            { ...incidents, mark: 'bar' },
            { field: 'damage', type: 'quantitative', mark: 'line', axis: 'right' },
          ],
        },
      })}
      result={BY_DISTRICT}
    />
  ),
  play: chartsReady,
}

export const Funnel: Story = {
  name: 'Воронка: обработка сообщений',
  render: () => (
    <Example
      title="Сообщения о происшествиях"
      spec={chartSpec({
        type: 'funnel',
        encoding: {
          x: { field: 'stage', type: 'nominal' },
          y: [{ field: 'count', type: 'quantitative' }],
        },
      })}
      result={PIPELINE}
    />
  ),
  play: chartsReady,
}

export const Gauge: Story = {
  name: 'Шкала с порогами',
  render: () => (
    <Example
      title="Готовность техники"
      spec={chartSpec({
        type: 'gauge',
        encoding: { y: [{ field: 'ready', type: 'quantitative' }] },
        options: {
          axes: { y: { min: 0, max: 100 } },
          target: 90,
          thresholds: [
            { value: 0, color: 'danger' },
            { value: 60, color: 'warning' },
            { value: 85, color: 'success' },
          ],
        },
      })}
      result={READINESS}
    />
  ),
  play: chartsReady,
}

export const Treemap: Story = {
  name: 'Древовидная карта: регионы и районы',
  render: () => (
    <Example
      title="Ущерб по регионам и районам"
      spec={chartSpec({
        type: 'treemap',
        encoding: {
          x: district,
          y: [{ field: 'damage', type: 'quantitative' }],
          color: { field: 'region', type: 'nominal' },
        },
      })}
      result={DAMAGE_TREE}
      height={320}
    />
  ),
  play: chartsReady,
}

export const Numbers: Story = {
  name: 'Показатели: дельта, цель, порог, искра',
  render: () => (
    <div className="grid w-[720px] grid-cols-3 gap-3">
      <Chart
        animation={false}
        result={KPI}
        spec={chartSpec({
          type: 'number',
          encoding: { x: month, y: [incidents] },
          options: { comparison: { mode: 'previous_period' } },
        })}
        direction="lower_better"
      />
      <Chart
        animation={false}
        result={KPI}
        spec={chartSpec({
          type: 'number',
          encoding: { x: month, y: [{ field: 'response', type: 'quantitative' }] },
          options: {
            comparison: { mode: 'previous_year' },
            target: 15,
            thresholds: [
              { value: 0, color: 'success' },
              { value: 18, color: 'warning' },
            ],
          },
        })}
        direction="lower_better"
      />
      <Chart
        animation={false}
        result={KPI}
        spec={chartSpec({
          type: 'number',
          encoding: { x: month, y: [{ field: 'damage', type: 'quantitative' }] },
          options: { comparison: { mode: 'previous_period' }, axes: { y: { unit: 'сомони' } } },
        })}
        direction="lower_better"
      />
    </div>
  ),
  play: chartsReady,
}

/** Крупный показатель — TV-режим дашборда: значение, дельта, цель, порог и искра. */
export const NumberLarge: Story = {
  name: 'Показатель крупно: TV-режим',
  render: () => (
    <div className="grid w-[960px] grid-cols-2 gap-4">
      <NumberTile
        size="lg"
        model={{
          label: 'Происшествия за месяц',
          value: 37,
          formatted: '37',
          unit: null,
          delta: {
            value: -0.08,
            formatted: '−8,0 %',
            direction: 'down',
            good: true,
            label: 'к прошлому периоду',
          },
          target: { value: 40, formatted: '40', progress: 40 / 37, label: 'Цель: 40' },
          status: 'success',
          spark: [52, 48, 44, 51, 39, 42, 40, 37],
        }}
      />
      <NumberTile
        size="lg"
        model={{
          label: 'Ущерб',
          value: 1_250_000,
          formatted: '1,25 млн',
          unit: 'сомони',
          delta: {
            value: 0.21,
            formatted: '+21,0 %',
            direction: 'up',
            good: false,
            label: 'к прошлому году',
          },
          target: null,
          status: 'danger',
          spark: [0.8, 0.9, 1.1, 0.95, 1.2, 1.25],
        }}
      />
    </div>
  ),
}

export const Table: Story = {
  name: 'Таблица',
  render: () => (
    <Example
      title="Происшествия и ущерб по районам"
      spec={chartSpec({
        type: 'table',
        encoding: {
          x: district,
          y: [incidents, { field: 'damage', type: 'quantitative' }],
        },
      })}
      result={BY_DISTRICT}
    />
  ),
  play: chartsReady,
}

export const DataTableView: Story = {
  name: 'Таблица данных вместо графика',
  render: () => (
    <Example
      title="Происшествия по регионам"
      spec={chartSpec({
        type: 'line',
        encoding: { x: month, y: [incidents], color: region },
      })}
      result={BY_MONTH_REGION}
    />
  ),
  play: async (context) => {
    await chartsReady(context)
    const canvas = within(context.canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: 'Таблица данных' }))
    await expect(canvas.getByRole('table')).toBeInTheDocument()
    await expect(canvas.getByRole('button', { name: 'График' })).toBeInTheDocument()
  },
}

export const Tooltip: Story = {
  name: 'Тултип: значение впереди, итог стопки',
  render: () => (
    <Example
      title="Происшествия по месяцам"
      spec={chartSpec({
        type: 'bar',
        encoding: { x: month, y: [incidents], color: region },
        options: { stacked: true },
      })}
      result={BY_MONTH_REGION}
    />
  ),
  play: async (context) => {
    await chartsReady(context)
    const element = context.canvasElement.querySelector<HTMLElement>('[role="img"]')
    const chart = element ? getInstanceByDom(element) : undefined
    chart?.dispatchAction({ type: 'showTip', seriesIndex: 1, dataIndex: 4 })
    await waitFor(() =>
      expect(context.canvasElement.querySelector('.kchs-chart-tip')).not.toBeNull(),
    )
  },
}

/** Контейнер ECharts, его canvas и экранные координаты точки данных. */
function chartAt(canvasElement: HTMLElement) {
  const element = canvasElement.querySelector<HTMLElement>('[role="img"]')
  const chart = element ? getInstanceByDom(element) : undefined
  const canvas = element?.querySelector('canvas')
  if (!element || !chart || !canvas) throw new Error('график не отрисован')
  const rect = element.getBoundingClientRect()
  const at = (finder: Parameters<typeof chart.convertToPixel>[0], value: (number | string)[]) => {
    const [x, y] = chart.convertToPixel(finder, value) as number[]
    return { clientX: rect.left + (x ?? 0), clientY: rect.top + (y ?? 0) }
  }
  /** Мышь zrender: события на canvas с экранными координатами (как у пользователя). */
  const mouse = (type: string, point: { clientX: number; clientY: number }) =>
    canvas.dispatchEvent(
      new MouseEvent(type, { bubbles: true, cancelable: true, view: window, button: 0, ...point }),
    )
  return { canvas, at, mouse }
}

const clicked = fn()

export const Click: Story = {
  name: 'Клик по столбцу — условия для детализации',
  render: () => (
    <Frame title="Происшествия по районам">
      <Chart
        animation={false}
        onElementClick={clicked}
        spec={chartSpec({
          type: 'bar',
          encoding: { x: district, y: [incidents] },
          options: { sort: { by: 'incidents', dir: 'desc' } },
        })}
        result={BY_DISTRICT}
      />
    </Frame>
  ),
  play: async (context) => {
    clicked.mockClear()
    await chartsReady(context)
    const { at, mouse } = chartAt(context.canvasElement)
    const point = at({ seriesIndex: 0 }, [1, 15])
    mouse('mousemove', point)
    mouse('mousedown', point)
    mouse('mouseup', point)
    mouse('click', point)
    await waitFor(() =>
      expect(clicked).toHaveBeenCalledWith({
        label: 'Варзоб',
        filters: [{ field: 'district', op: 'eq', value: 'Варзоб' }],
      }),
    )
  },
}

const brushed = fn()

export const Brush: Story = {
  name: 'Кисть по времени — диапазон месяцев',
  render: () => (
    <Frame title="Происшествия по регионам">
      <Chart
        animation={false}
        onBrush={brushed}
        colorDomain={REGIONS}
        spec={chartSpec({
          type: 'line',
          encoding: { x: month, y: [incidents], color: region },
          options: { brush: true },
        })}
        result={BY_MONTH_REGION}
      />
    </Frame>
  ),
  play: async (context) => {
    brushed.mockClear()
    await chartsReady(context)
    const { at, mouse } = chartAt(context.canvasElement)
    const grid = { xAxisIndex: 0, yAxisIndex: 0 }
    const from = at(grid, [Date.UTC(2026, 2, 15), 40])
    const to = at(grid, [Date.UTC(2026, 5, 15), 40])
    mouse('mousemove', from)
    mouse('mousedown', from)
    mouse('mousemove', { ...from, clientX: (from.clientX + to.clientX) / 2 })
    mouse('mousemove', to)
    mouse('mouseup', to)
    await waitFor(() =>
      expect(brushed).toHaveBeenCalledWith({
        field: 'month',
        op: 'between',
        value: ['2026-04-01', '2026-06-01'],
      }),
    )
  },
}

export const States: Story = {
  name: 'Состояния: нет данных, ошибка спецификации, карта',
  render: () => (
    <div className="grid w-[720px] grid-cols-3 gap-3">
      <Card title="Пустой период">
        <Chart
          animation={false}
          height={160}
          spec={chartSpec({ type: 'bar', encoding: { x: district, y: [incidents] } })}
          result={{ ...BY_DISTRICT, rows: [] }}
        />
      </Card>
      <Card title="Поле удалено">
        <Chart
          animation={false}
          height={160}
          spec={chartSpec({
            type: 'bar',
            encoding: { x: district, y: [{ field: 'victims', type: 'quantitative' }] },
          })}
          result={BY_DISTRICT}
        />
      </Card>
      <Card title="Карта">
        <Chart
          animation={false}
          height={160}
          spec={chartSpec({ type: 'map', encoding: {} })}
          result={queryResult([{ name: 'district', type: 'text' }], [['Рудаки']])}
        />
      </Card>
    </div>
  ),
  play: chartsReady,
}

export const Pending: Story = {
  name: 'Перезапрос: прежний кадр приглушён',
  render: () => (
    <Frame title="Происшествия по районам">
      <Chart
        animation={false}
        pending
        spec={chartSpec({
          type: 'bar',
          encoding: { x: district, y: [incidents] },
          options: { sort: { by: 'incidents', dir: 'desc' } },
        })}
        result={BY_DISTRICT}
      />
    </Frame>
  ),
  play: chartsReady,
}
