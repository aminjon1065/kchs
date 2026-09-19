import { LayerStyle, type LayerStyleInput, STYLE_PALETTES } from '@kchs/contracts'
import {
  compileLayerStyle,
  type MapStyleContext,
  paletteColors,
  type StyleField,
} from '@kchs/map-style'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { Hospital, type LucideIcon, School, Shield } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { expect, waitFor } from 'storybook/test'
import { Card } from '../components/data-display.js'
import { useUiLocale } from '../i18n/ui-locale.js'
import { MapLegend } from './map-legend.js'
import { useMapTheme } from './map-theme.js'

const meta = {
  title: 'Карты/Легенда',
  id: 'maps-legend',
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

/** Поля датасета «Объекты и районы» — подписи и форматы легенды. */
const FIELDS: StyleField[] = [
  {
    key: 'kind',
    type: 'select',
    label: { ru: 'Вид объекта', tg: 'Намуди объект', en: 'Kind' },
    options: [
      { value: 'school', label: { ru: 'Школа', en: 'School' } },
      { value: 'hospital', label: { ru: 'Больница', en: 'Hospital' } },
      { value: 'police', label: { ru: 'Полиция', en: 'Police' } },
    ],
  },
  { key: 'population', type: 'integer', label: { ru: 'Население', en: 'Population' } },
  { key: 'area_km2', type: 'decimal', label: { ru: 'Площадь, км²', en: 'Area, km²' } },
  { key: 'capacity', type: 'integer', label: { ru: 'Вместимость', en: 'Capacity' } },
  { key: 'severity', type: 'integer', label: { ru: 'Тяжесть', en: 'Severity' } },
  { key: 'change', type: 'percent', label: { ru: 'Изменение', en: 'Change' } },
  { key: 'active', type: 'boolean', label: { ru: 'Действует', en: 'Active' } },
]

const ICONS: Record<string, LucideIcon> = { school: School, hospital: Hospital, police: Shield }

/** Значки легенды — те же глифы Lucide, что MapView растрирует в SDF-изображения. */
function renderIcon(name: string, color: string, size: number): ReactNode {
  const Icon = ICONS[name]
  return Icon ? <Icon size={size} color={color} strokeWidth={2.25} /> : null
}

/** Легенды на странице отрисованы: тема карты прочитана из CSS-переменных. */
async function legendsReady({ canvasElement }: { canvasElement: HTMLElement }): Promise<void> {
  await waitFor(() => {
    const cards = [...canvasElement.querySelectorAll('[data-legend-state]')]
    expect(cards.length).toBeGreaterThan(0)
    for (const card of cards) expect(card.getAttribute('data-legend-state')).toBe('ready')
  })
}

function Example({
  title,
  style,
  context,
}: {
  title: string
  style: Omit<LayerStyleInput, 'version'>
  context?: Partial<MapStyleContext>
}) {
  const [element, setElement] = useState<HTMLDivElement | null>(null)
  const theme = useMapTheme(element)
  const locale = useUiLocale()
  const compiled = theme
    ? compileLayerStyle(LayerStyle.parse({ version: 1, ...style }), {
        id: 'story',
        source: 'story',
        fields: FIELDS,
        theme,
        locale,
        name: title,
        ...context,
      })
    : null
  return (
    <div ref={setElement} data-legend-state={compiled ? 'ready' : 'pending'}>
      <Card title={title}>
        {compiled ? <MapLegend legend={compiled.legend} renderIcon={renderIcon} /> : null}
      </Card>
    </div>
  )
}

function Grid({ children }: { children: ReactNode }) {
  return <div className="grid w-[840px] grid-cols-3 items-start gap-4">{children}</div>
}

export const Categories: Story = {
  name: 'Категории и правила',
  play: legendsReady,
  render: () => (
    <Grid>
      <Example
        title="Социальные объекты"
        style={{
          geometry: 'point',
          renderer: {
            kind: 'categorized',
            field: 'kind',
            categories: [
              { value: 'school', color: 'categorical.1', icon: 'school' },
              { value: 'hospital', color: 'danger', icon: 'hospital' },
              { value: 'police', color: 'categorical.5', icon: 'police' },
            ],
            other: { color: 'other' },
          },
          point: { size: 14 },
        }}
      />
      <Example
        title="Посты по статусу"
        style={{
          geometry: 'point',
          renderer: {
            kind: 'categorized',
            field: 'active',
            categories: [
              { value: true, color: 'success' },
              { value: false, color: 'neutral' },
              { value: null, color: 'warning', label: { ru: 'Не проверен', en: 'Not checked' } },
            ],
          },
          point: { shape: 'square', size: 10 },
        }}
      />
      <Example
        title="Районы по правилам"
        style={{
          geometry: 'polygon',
          renderer: {
            kind: 'rule',
            rules: [
              {
                filter: { field: 'severity', op: 'gte', value: 4 },
                color: 'danger',
                label: { ru: 'Высокий риск', en: 'High risk' },
              },
              {
                filter: { field: 'severity', op: 'between', value: [2, 3] },
                color: 'warning',
                label: { ru: 'Средний риск', en: 'Medium risk' },
              },
            ],
            other: { color: 'success', label: { ru: 'Низкий риск', en: 'Low risk' } },
          },
        }}
      />
    </Grid>
  ),
}

export const Classes: Story = {
  name: 'Классы: хороплет и расходящаяся шкала',
  play: legendsReady,
  render: () => (
    <Grid>
      <Example
        title="Плотность населения"
        style={{
          geometry: 'polygon',
          renderer: {
            kind: 'graduated',
            field: 'population',
            method: 'jenks',
            classes: 5,
            palette: { name: 'blue', reverse: false },
            normalizeBy: 'area_km2',
          },
          legend: { title: { ru: 'Население на км²', en: 'Population per km²' } },
        }}
        context={{
          breaks: [2.4, 18, 64, 210, 890, 5400],
          domains: { population: { min: 1200, max: 850_000, nulls: 2 } },
        }}
      />
      <Example
        title="Изменение за год"
        style={{
          geometry: 'line',
          renderer: {
            kind: 'graduated',
            field: 'change',
            method: 'manual',
            classes: 5,
            breaks: [-0.4, -0.15, -0.05, 0.05, 0.15, 0.4],
            palette: { name: 'brown-teal', reverse: false },
            visual: { target: 'both' },
          },
          line: { width: 1.5, dash: null, cap: 'round' },
        }}
      />
      <Example
        title="Классы не рассчитаны"
        style={{
          geometry: 'polygon',
          renderer: { kind: 'graduated', field: 'population', method: 'quantile' },
        }}
      />
    </Grid>
  ),
}

export const SizesAndDensity: Story = {
  name: 'Размер, кластеры и тепловая карта',
  play: legendsReady,
  render: () => (
    <Grid>
      <Example
        title="Школы по вместимости"
        style={{
          geometry: 'point',
          renderer: { kind: 'simple', color: 'categorical.1' },
          point: { sizeBy: { field: 'capacity', min: 6, max: 28, scale: 'sqrt' } },
          cluster: { enabled: true },
        }}
        context={{ domains: { capacity: { min: 40, max: 1600 } } }}
      />
      <Example
        title="Койки больниц"
        style={{
          geometry: 'point',
          renderer: {
            kind: 'proportional',
            field: 'capacity',
            min: 4,
            max: 64,
            scale: 'sqrt',
            color: 'teal.6',
          },
        }}
        context={{ domains: { capacity: { min: 10, max: 900 } } }}
      />
      <Example
        title="Происшествия"
        style={{
          geometry: 'point',
          renderer: {
            kind: 'heatmap',
            weightField: 'severity',
            palette: { name: 'orange', reverse: false },
          },
        }}
        context={{ domains: { severity: { min: 1, max: 5 } } }}
      />
    </Grid>
  ),
}

/** Шкалы карт из токенов (`--seq-*`, `--div-*`): классы 3–9 в текущей теме. */
function Ramps() {
  const [element, setElement] = useState<HTMLDivElement | null>(null)
  const theme = useMapTheme(element)
  return (
    <div
      ref={setElement}
      data-legend-state={theme ? 'ready' : 'pending'}
      className="flex w-[840px] flex-col gap-3 rounded-lg border border-line bg-surface p-4"
    >
      {theme
        ? STYLE_PALETTES.map((name) => (
            <div key={name} className="grid grid-cols-[96px_repeat(4,1fr)] items-center gap-3">
              <span className="font-mono text-xs text-fg-secondary">{name}</span>
              {[3, 5, 7, 9].map((n) => (
                <svg
                  key={n}
                  className="h-4 w-full"
                  viewBox={`0 0 ${n} 1`}
                  preserveAspectRatio="none"
                  aria-hidden="true"
                >
                  {paletteColors(theme, name, n).map((color, i) => (
                    <rect key={`${color}-${i}`} x={i} y={0} width={1} height={1} fill={color} />
                  ))}
                </svg>
              ))}
            </div>
          ))
        : null}
    </div>
  )
}

export const Palettes: Story = {
  name: 'Шкалы карт',
  play: legendsReady,
  render: () => <Ramps />,
}
