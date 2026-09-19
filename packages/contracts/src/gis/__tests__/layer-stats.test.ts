import { describe, expect, it } from 'vitest'
import { LayerTilePreview } from '../layer.js'
import { LayerStatsInput } from '../layer-stats.js'
import { LayerStyle } from '../layer-style.js'
import { layerTilePreview } from '../layer-style-fields.js'

describe('статистика слоя и предпросмотр стиля (ADR-0075)', () => {
  it('запрос статистики: по умолчанию — диапазон без классов, ручной метод не принимается', () => {
    expect(LayerStatsInput.parse({ field: 'amount' })).toEqual({
      field: 'amount',
      normalizeBy: null,
      method: null,
      classes: 5,
    })
    expect(
      LayerStatsInput.safeParse({ field: 'amount', method: 'manual' }).success,
      'ручные границы задаёт стиль, считать нечего',
    ).toBe(false)
    expect(LayerStatsInput.safeParse({ field: 'amount', classes: 12 }).success).toBe(false)
  })

  it('предпросмотр стиля — поля тайла, фильтр, кластеры, масштабы и время рабочей копии', () => {
    const style = LayerStyle.parse({
      version: 1,
      geometry: 'point',
      renderer: {
        kind: 'categorized',
        field: 'kind',
        categories: [{ value: 'school', color: 'categorical.1' }],
      },
      label: { field: 'name' },
      popup: { title: '{{code}}', fields: ['phone'], actions: [] },
      filter: { field: 'amount', op: 'gte', value: 10 },
      cluster: { enabled: true },
      time: { field: 'day' },
      minZoom: 4,
    })
    const preview = layerTilePreview(style)
    // Карточка объекта (code, phone) в тайл не входит — её читают по щелчку
    expect(preview.fields).toEqual(['kind', 'name', 'day'])
    expect(LayerTilePreview.parse(JSON.parse(JSON.stringify(preview)))).toEqual(preview)
    expect(preview).toMatchObject({
      filter: { field: 'amount', op: 'gte', value: 10 },
      cluster: { enabled: true, radius: 40, maxZoom: 11 },
      minZoom: 4,
      maxZoom: 22,
      time: { field: 'day', mode: 'range', step: 'day' },
    })
  })
})
