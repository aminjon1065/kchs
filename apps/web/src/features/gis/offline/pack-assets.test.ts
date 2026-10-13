import { describe, expect, it } from 'vitest'
import { assetUrls, wrapAssetUrls } from './pack-source.js'

/** Шрифты и значки карты района без сети (ADR-0211): что ложится на устройство. */
describe('assetUrls', () => {
  it('шрифты наборов text-font по диапазонам кириллицы и латиницы и спрайт в двух плотностях', () => {
    const style = wrapAssetUrls({
      glyphs: 'https://kchs.example/api/v1/gis/glyphs/{fontstack}/{range}.pbf',
      sprite: 'https://kchs.example/api/v1/gis/sprites/basemap-light',
      layers: [
        { id: 'place', layout: { 'text-font': ['Noto Sans Regular'] } },
        { id: 'peak', layout: { 'text-font': ['Noto Sans Italic'] } },
        // Выражение вместо списка — пропускается
        { id: 'road', layout: { 'text-font': ['literal', ['Noto Sans Bold']] } },
        { id: 'water' },
      ],
    })
    const urls = assetUrls(style)
    expect(urls).toContain('https://kchs.example/api/v1/gis/glyphs/Noto Sans Regular/1024-1279.pbf')
    expect(urls).toContain('https://kchs.example/api/v1/gis/glyphs/Noto Sans Italic/0-255.pbf')
    expect(urls.filter((url) => url.includes('/glyphs/'))).toHaveLength(8)
    expect(urls.filter((url) => url.includes('/sprites/'))).toEqual([
      'https://kchs.example/api/v1/gis/sprites/basemap-light.json',
      'https://kchs.example/api/v1/gis/sprites/basemap-light.png',
      'https://kchs.example/api/v1/gis/sprites/basemap-light@2x.json',
      'https://kchs.example/api/v1/gis/sprites/basemap-light@2x.png',
    ])
  })
})
