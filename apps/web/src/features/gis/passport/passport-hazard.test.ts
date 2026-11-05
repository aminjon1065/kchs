import { describe, expect, it } from 'vitest'
import type { MapOverlayZone } from '../map-overlays.js'
import { hazardFor } from './passport-hazard.js'

const name = (ru: string) => ({ ru, tg: ru, en: ru })
const unit = {
  id: 'ayni',
  name: name('Айни'),
  path: [{ id: 'sughd', name: name('Согдийская область') }],
  children: [{ id: 'village', name: name('Зеравшан') }],
} as unknown as Parameters<typeof hazardFor>[0]
const zone = (patch: Partial<MapOverlayZone>): MapOverlayZone => ({
  geometry: { type: 'Polygon', coordinates: [] },
  level: 2,
  title: 'Лавинная опасность',
  objectId: 'w1',
  objectType: 'warning',
  ...patch,
})

describe('обстановка в паспорте территории', () => {
  it('своя зона, зона предка и вложенной единицы — берётся самая строгая', () => {
    const result = hazardFor(unit, [
      zone({ territoryId: 'sughd', level: 1, objectId: 'w0', title: 'Паводок' }),
      zone({ territoryId: 'ayni', level: 2 }),
      zone({ territoryId: 'village', level: 3, objectId: 'w2', title: 'Сель' }),
    ])
    expect(result?.zone.title).toBe('Сель')
    expect(result?.territory?.id).toBe('village')
    expect(result?.more).toBe(2)
  })

  it('чужая территория, своя область без территории и норма — плашки нет', () => {
    expect(
      hazardFor(unit, [
        zone({ territoryId: 'varzob' }),
        zone({ territoryId: undefined }),
        zone({ territoryId: 'ayni', level: 0 }),
      ]),
    ).toBeNull()
  })

  it('несколько областей одного предупреждения — одно предупреждение, «ещё» нет', () => {
    const result = hazardFor(unit, [
      zone({ territoryId: 'ayni' }),
      zone({ territoryId: 'village' }),
    ])
    expect(result?.more).toBe(0)
  })
})
