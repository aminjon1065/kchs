import type { Territory } from '@kchs/contracts'
import { describe, expect, it } from 'vitest'
import { searchKey } from './geocoder.js'
import { TerritoryIndex } from './territory-index.js'
import { simplifyTolerance } from './territory-service.js'
import { tileLevels } from './territory-tiles.js'

const unit = (
  id: string,
  code: string,
  level: Territory['level'],
  parentId: string | null,
  ru: string,
): Territory => ({ id, code, level, parentId, name: { ru }, kind: null, centroid: null })

const index = new TerritoryIndex('test', [
  unit('tj', 'TJ', 'country', null, 'Таджикистан'),
  unit('kt', 'TJ-KT', 'region', 'tj', 'Хатлонская область'),
  unit('vakhsh', 'TJ-KT-07', 'district', 'kt', 'Вахш'),
  unit('panj', 'TJ-KT-17', 'district', 'kt', 'Пяндж'),
  // Кишлаки с именем района и два одноимённых кишлака
  unit('v1', 'TJ-KT-07-01', 'settlement', 'vakhsh', 'Пяндж'),
  unit('v2', 'TJ-KT-07-02', 'settlement', 'vakhsh', 'Навобод'),
  unit('p1', 'TJ-KT-17-01', 'settlement', 'panj', 'Навобод'),
])

describe('справочник территорий в памяти', () => {
  it('название принадлежит единице крупнейшего уровня; одноимённые на одном уровне неоднозначны', () => {
    expect(index.resolve('пяндж')).toBe('panj')
    expect(index.resolve('Навобод')).toBe('ambiguous')
    expect(index.resolve('tj-kt-07-01')).toBe('v1')
    expect(index.matchTable()).toMatchObject({ навобод: '', 'tj-kt-17': 'panj' })
  })

  it('предки — от корня до родителя', () => {
    expect(index.ancestors('v2').map((item) => item.code)).toEqual(['TJ', 'TJ-KT', 'TJ-KT-07'])
    expect(index.ancestors('tj')).toEqual([])
  })
})

describe('геокодер и тайлы границ', () => {
  it('ключ поиска: регистр, «ё», таджикские буквы, кавычки и дефисы', () => {
    expect(searchKey('Кӯлоб')).toBe('кулоб')
    expect(searchKey(' Хуҷанд ')).toBe('хучанд')
    expect(searchKey('Kal’ai  Nav')).toBe('kalai nav')
    expect(searchKey('Шуро-обод')).toBe('шуро обод')
    expect(searchKey('Лёвакант')).toBe('левакант')
  })

  it('уровни тайла: заданные или видимые на зуме; допуск упрощения — пиксель', () => {
    expect(tileLevels(3, undefined)).toEqual(['country', 'region'])
    expect(tileLevels(10, undefined)).toEqual([
      'country',
      'region',
      'district',
      'jamoat',
      'settlement',
    ])
    expect(tileLevels(3, 'settlement,region')).toEqual(['region', 'settlement'])
    expect(simplifyTolerance(0)).toBeCloseTo(360 / 512)
    expect(simplifyTolerance(12)).toBeGreaterThan(0)
    expect(simplifyTolerance(13)).toBe(0)
  })
})
