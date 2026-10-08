import type { Basemap } from '@kchs/contracts'
import { describe, expect, it } from 'vitest'
import { autoBasemap, resolveBasemap, variantsOf } from './basemap-choice.js'

function basemap(id: string, patch: Partial<Basemap> = {}): Basemap {
  return {
    id,
    key: null,
    name: id,
    kind: 'raster',
    isDefault: false,
    attribution: null,
    minZoom: 0,
    maxZoom: 19,
    bounds: null,
    build: null,
    url: null,
    hasKey: false,
    tileSize: 256,
    service: null,
    imagery: false,
    version: 1,
    updatedAt: '2026-10-08T00:00:00Z',
    ...patch,
  }
}

const osm = basemap('osm', { kind: 'vector', isDefault: true, tileSize: null })
const sentinel = basemap('sentinel', { imagery: true })
const topo = basemap('topo')
const none = basemap('none', { kind: 'none', key: 'none', tileSize: null })
const items = [osm, sentinel, topo, none]

describe('личный выбор подложки (ADR-0196)', () => {
  it('без выбора — как в карте: подложка автора, иначе по умолчанию установки', () => {
    expect(resolveBasemap(items, null, 'topo', 'light', 'light')).toEqual({
      basemap: topo,
      theme: 'light',
      labels: false,
    })
    expect(resolveBasemap(items, null, null, 'muted', 'dark').basemap).toBe(osm)
    expect(autoBasemap(items, 'deleted')).toBe(osm)
  })

  it('выбор действует поверх карты: серая схема — тема muted, схема — тема интерфейса', () => {
    expect(
      resolveBasemap(items, { basemapId: 'osm', variant: 'muted' }, 'topo', 'light', 'light'),
    ).toEqual({ basemap: osm, theme: 'muted', labels: false })
    // Паспорт территории по умолчанию серый, но «Схема» — светлая или тёмная по интерфейсу
    expect(
      resolveBasemap(items, { basemapId: 'osm', variant: 'scheme' }, null, 'muted', 'dark'),
    ).toEqual({ basemap: osm, theme: 'dark', labels: false })
  })

  it('«Гибрид» — только у снимков и при векторной подложке в установке', () => {
    expect(
      resolveBasemap(items, { basemapId: 'sentinel', variant: 'hybrid' }, null, 'light', 'light'),
    ).toEqual({ basemap: sentinel, theme: 'light', labels: true })
    expect(variantsOf(sentinel, items)).toEqual(['plain', 'hybrid'])
    expect(variantsOf(topo, items)).toEqual(['plain'])
    expect(variantsOf(sentinel, [sentinel, topo])).toEqual(['plain'])
    // Вариант, которого у подложки нет, и удалённая подложка — назад к «как в карте»
    expect(
      resolveBasemap(items, { basemapId: 'topo', variant: 'hybrid' }, null, 'light', 'light')
        .basemap,
    ).toBe(osm)
    expect(
      resolveBasemap(items, { basemapId: 'gone', variant: 'plain' }, 'topo', 'light', 'light')
        .basemap,
    ).toBe(topo)
  })
})
