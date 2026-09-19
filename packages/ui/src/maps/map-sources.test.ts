import { describe, expect, it } from 'vitest'
import { tilesOnlyChange } from './map-sources.js'

const vector = (url: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'vector', tiles: [url], minzoom: 0, maxzoom: 16, ...extra })

describe('источник: сменился только адрес тайлов', () => {
  it('новый интервал времени — новые адреса без пересоздания источника', () => {
    expect(
      tilesOnlyChange(vector('/t?t=2026-03-01/2026-03-01'), vector('/t?t=2026-03-02/2026-03-02')),
    ).toEqual(['/t?t=2026-03-02/2026-03-02'])
  })

  it('сменились масштабы или вид источника, источник новый — пересоздать', () => {
    expect(tilesOnlyChange(vector('/a'), vector('/b', { maxzoom: 14 }))).toBeNull()
    expect(tilesOnlyChange(undefined, vector('/b'))).toBeNull()
    expect(
      tilesOnlyChange(
        vector('/a'),
        JSON.stringify({ type: 'geojson', data: { type: 'FeatureCollection', features: [] } }),
      ),
    ).toBeNull()
    expect(tilesOnlyChange('{', vector('/b'))).toBeNull()
  })
})
