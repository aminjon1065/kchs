import { describe, expect, it } from 'vitest'
import { LayerStyle } from '../layer-style.js'
import { MapSpec } from '../map.js'

describe('контракт LayerStyle (docs/contracts/layer-style.md)', () => {
  it('пример из контракта разбирается без изменений', () => {
    const example = {
      version: 1,
      geometry: 'point',
      renderer: {
        kind: 'graduated',
        field: 'population',
        method: 'quantile',
        classes: 5,
        breaks: null,
        palette: { name: 'blue', reverse: false },
        normalizeBy: 'area_km2',
        visual: { target: 'fill' },
      },
      point: {
        shape: 'circle',
        size: 8,
        icon: null,
        sizeBy: { field: 'capacity', min: 4, max: 24, scale: 'sqrt' },
      },
      line: { width: 2, dash: null, cap: 'round' },
      polygon: { fillOpacity: 0.6, outline: { width: 1, color: 'auto' } },
      heatmap: null,
      cluster: {
        enabled: true,
        radius: 40,
        maxZoom: 11,
        style: { sizeBy: 'point_count', min: 16, max: 48 },
      },
      label: {
        field: 'name',
        template: null,
        size: 12,
        halo: true,
        minZoom: 9,
        priority: 'size',
        placement: 'auto',
      },
      popup: {
        title: '{{name}}',
        fields: ['type', 'capacity', 'territory_id'],
        actions: ['open', 'documents', 'instruction'],
      },
      opacity: 1,
      minZoom: 0,
      maxZoom: 22,
      filter: null,
      legend: { title: { ru: 'Население на км²' }, format: { precision: 0 }, show: true },
      time: { field: 'occurred_at', mode: 'instant', step: 'day' },
      extrusion: null,
      raster: null,
    }
    expect(LayerStyle.parse(example)).toEqual(example)
  })

  it('минимальный стиль дополняется значениями по умолчанию; чужой цвет отклоняется', () => {
    const style = LayerStyle.parse({
      version: 1,
      geometry: 'polygon',
      renderer: { kind: 'simple' },
    })
    expect(style.renderer).toEqual({ kind: 'simple', color: 'categorical.1', icon: null })
    expect(style.polygon).toEqual({ fillOpacity: 0.6, outline: { width: 1, color: 'auto' } })
    expect(style.cluster).toBeNull()
    const invalid = LayerStyle.safeParse({
      version: 1,
      geometry: 'point',
      renderer: { kind: 'simple', color: 'rgb(1,2,3)' },
    })
    expect(invalid.success).toBe(false)
  })

  it('карта по умолчанию — Таджикистан целиком, без слоёв', () => {
    expect(MapSpec.parse({})).toEqual({
      basemapId: null,
      camera: { center: [69, 38.6], zoom: 6, bearing: 0, pitch: 0 },
      layers: [],
      bookmarks: [],
      time: null,
    })
  })
})
