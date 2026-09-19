import { LayerStyle, type LayerStyleInput } from '@kchs/contracts'
import { compileLayerStyle, type StyleField } from '@kchs/map-style'
import type { Meta, StoryObj } from '@storybook/react-vite'
import type { LayerSpecification, SourceSpecification } from 'maplibre-gl'
import { useMemo, useState } from 'react'
import { expect, waitFor } from 'storybook/test'
import { useUiLocale } from '../i18n/ui-locale.js'
import { MapCanvas } from './map-canvas.js'
import { useMapTheme } from './map-theme.js'

const meta = {
  title: 'Карты/Холст',
  id: 'maps-canvas',
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

const FIELDS: StyleField[] = [
  {
    key: 'kind',
    type: 'select',
    label: { ru: 'Вид объекта', en: 'Kind' },
    options: [
      { value: 'school', label: { ru: 'Школа', en: 'School' } },
      { value: 'hospital', label: { ru: 'Больница', en: 'Hospital' } },
    ],
  },
  { key: 'name', type: 'text', label: { ru: 'Название', en: 'Name' } },
  { key: 'level', type: 'integer', label: { ru: 'Уровень', en: 'Level' } },
]

type Feature = {
  type: 'Feature'
  id: number
  properties: Record<string, unknown>
  geometry: unknown
}

const point = (id: number, lon: number, lat: number, kind: string, name: string): Feature => ({
  type: 'Feature',
  id,
  properties: { kind, name },
  geometry: { type: 'Point', coordinates: [lon, lat] },
})

/** Объекты Душанбе: школы и больницы — значки по категориям. */
const OBJECTS = {
  type: 'FeatureCollection',
  features: [
    point(1, 68.765, 38.575, 'school', 'Школа № 1'),
    point(2, 68.79, 38.56, 'hospital', 'Больница'),
    point(3, 68.81, 38.585, 'school', 'Школа № 2'),
    point(4, 68.745, 38.55, 'hospital', 'Поликлиника'),
  ],
}

/** Зона риска (полигон) и русло (линия). */
const ZONES = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      id: 10,
      properties: { level: 3, name: 'Сель' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [68.74, 38.565],
            [68.78, 38.565],
            [68.78, 38.595],
            [68.74, 38.595],
            [68.74, 38.565],
          ],
        ],
      },
    },
  ],
}

const RIVER = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      id: 20,
      properties: { name: 'Душанбинка' },
      geometry: {
        type: 'LineString',
        coordinates: [
          [68.77, 38.61],
          [68.78, 38.58],
          [68.775, 38.55],
          [68.79, 38.53],
        ],
      },
    },
  ],
}

function compile(
  id: string,
  style: Omit<LayerStyleInput, 'version'>,
  theme: NonNullable<ReturnType<typeof useMapTheme>>,
  locale: ReturnType<typeof useUiLocale>,
) {
  return compileLayerStyle(LayerStyle.parse({ version: 1, ...style }), {
    id,
    source: id,
    sourceLayer: null,
    fields: FIELDS,
    theme,
    locale,
  })
}

function DataLayers() {
  const [element, setElement] = useState<HTMLDivElement | null>(null)
  const theme = useMapTheme(element)
  const locale = useUiLocale()
  const rendered = useMemo(() => {
    if (!theme) return null
    const zones = compile(
      'zones',
      {
        geometry: 'polygon',
        renderer: { kind: 'simple', color: 'warning' },
        polygon: { fillOpacity: 0.35 },
      },
      theme,
      locale,
    )
    const river = compile(
      'river',
      { geometry: 'line', renderer: { kind: 'simple', color: 'info' }, line: { width: 3 } },
      theme,
      locale,
    )
    const objects = compile(
      'objects',
      {
        geometry: 'point',
        renderer: {
          kind: 'categorized',
          field: 'kind',
          categories: [
            { value: 'school', color: 'categorical.1', icon: 'school' },
            { value: 'hospital', color: 'danger', icon: 'hospital' },
          ],
        },
        point: { shape: 'icon', size: 22 },
      },
      theme,
      locale,
    )
    const sources: Record<string, SourceSpecification> = {
      zones: { type: 'geojson', data: ZONES as never },
      river: { type: 'geojson', data: RIVER as never },
      objects: { type: 'geojson', data: OBJECTS as never },
    }
    return {
      sources,
      layers: [...zones.layers, ...river.layers, ...objects.layers] as LayerSpecification[],
      images: [...zones.images, ...river.images, ...objects.images],
    }
  }, [theme, locale])
  return (
    <div
      ref={setElement}
      className="h-[420px] w-[720px] overflow-hidden rounded-md border border-line"
    >
      {rendered ? (
        <MapCanvas
          className="h-full"
          basemapStyle={null}
          sources={rendered.sources}
          layers={rendered.layers}
          images={rendered.images}
          camera={{ center: [68.777, 38.571], zoom: 12.15, bearing: 0, pitch: 0 }}
          aria-label="Объекты Душанбе"
        />
      ) : null}
    </div>
  )
}

/** Карта нарисована: тайлы загружены, значки растрированы, переходов нет. */
async function mapIdle({ canvasElement }: { canvasElement: HTMLElement }): Promise<void> {
  await waitFor(
    () => {
      const map = canvasElement.querySelector('[data-map-state]')
      expect(map?.getAttribute('data-map-state')).toBe('idle')
    },
    { timeout: 15_000 },
  )
}

export const DataOnly: Story = {
  name: 'Слои данных без подложки',
  play: mapIdle,
  render: () => <DataLayers />,
}
