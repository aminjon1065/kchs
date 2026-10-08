import { describe, expect, it } from 'vitest'
import { BASEMAP_PRESETS, BasemapCreateInput, BasemapStyleQuery } from '../basemap.js'

describe('каталог внешних подложек (ADR-0196)', () => {
  it('каждая подложка каталога проходит проверку создания: XYZ без ключа', () => {
    for (const preset of BASEMAP_PRESETS) {
      const { key: _key, ...input } = preset
      const parsed = BasemapCreateInput.safeParse({ ...input, kind: 'raster' })
      expect(parsed.success, preset.key).toBe(true)
      expect(preset.url).not.toContain('{key}')
      expect(preset.url.startsWith('https://')).toBe(true)
    }
  })

  it('ключи каталога уникальны', () => {
    const keys = BASEMAP_PRESETS.map((preset) => preset.key)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('запрос стиля подложки', () => {
  it('по умолчанию — обычный рельеф и без подписей поверх', () => {
    expect(BasemapStyleQuery.parse({})).toMatchObject({ relief: 'normal', labels: false })
  })

  it('рельеф и «Гибрид» — из строки запроса', () => {
    expect(BasemapStyleQuery.parse({ relief: 'none', labels: 'true' })).toMatchObject({
      relief: 'none',
      labels: true,
    })
    expect(BasemapStyleQuery.safeParse({ relief: 'max' }).success).toBe(false)
  })
})
