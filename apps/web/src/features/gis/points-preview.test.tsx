import type { QuerySpec } from '@kchs/contracts'
import { screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { renderWithClient, stubApi } from '~/test/render.js'
import { PointsPreview, pointsSpec } from './points-preview.js'

/**
 * Точки «Исследования» на карте (ADR-0217, «Дополнено»): запрос — фильтр плана,
 * только строки с точкой и только её поле, не больше лимита; источник карты —
 * GeoJSON с кластерами MapLibre.
 */
const sources: unknown[] = []
vi.mock('@kchs/ui', async (original) => ({
  ...(await original<typeof import('@kchs/ui')>()),
  MapCanvas: (props: { 'aria-label'?: string; sources?: unknown; controls?: ReactNode }) => {
    sources.push(props.sources)
    return <section aria-label={props['aria-label']} />
  },
  useMapTheme: () => null,
}))
vi.mock('./basemaps.js', () => ({
  registerPmtilesProtocol: () => undefined,
  useBasemapStyle: () => ({ style: null, auto: true, basemap: null }),
}))
vi.mock('./basemap-switcher.js', () => ({ BasemapSwitcher: () => null }))

const DATASET = '00000000-0000-4000-8000-0000000000d1'

describe('pointsSpec', () => {
  it('фильтр плана, непустая точка, одно поле, лимит', () => {
    const spec = pointsSpec(DATASET, 'location', { field: 'kind', op: 'eq', value: 'fire' })
    expect(spec.steps).toEqual([
      { type: 'filter', where: { field: 'kind', op: 'eq', value: 'fire' } },
      { type: 'filter', where: { field: 'location', op: 'not_empty' } },
      { type: 'select', fields: ['location'] },
      { type: 'limit', limit: 5000, offset: 0 },
    ])
    expect(pointsSpec(DATASET, 'location', null).steps[0]).toEqual({
      type: 'filter',
      where: { field: 'location', op: 'not_empty' },
    })
  })
})

describe('PointsPreview', () => {
  it('точки — источником с кластерами; под картой — сколько точек', async () => {
    const specs: QuerySpec[] = []
    stubApi({
      'POST /queries/run': ({ init }: { init: RequestInit | undefined }) => {
        specs.push((JSON.parse(String(init?.body)) as { spec: QuerySpec }).spec)
        return {
          fields: [{ name: 'location', type: 'geometry' }],
          rows: [
            [{ type: 'Point', coordinates: [68.78, 38.56] }],
            [{ type: 'Point', coordinates: [69.1, 37.9] }],
            [null],
          ],
          truncated: false,
          durationMs: 4,
          cached: false,
        }
      },
    })
    renderWithClient(<PointsPreview datasetId={DATASET} field="location" filter={null} />)
    expect(await screen.findByRole('region', { name: 'Точки на карте' })).toBeInTheDocument()
    expect(screen.getByText('2 точки, близкие собраны в кластеры')).toBeVisible()
    expect(specs[0]?.steps.map((step) => step.type)).toEqual(['filter', 'select', 'limit'])
    expect(sources.at(-1)).toMatchObject({
      'explore-points': { type: 'geojson', cluster: true },
    })
  })
})
