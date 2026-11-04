import type { WarningSummary } from '@kchs/contracts'
import { describe, expect, it } from 'vitest'
import { pickSituation } from './ops-band.js'

const NOW = Date.parse('2026-11-04T12:00:00Z')

const warning = (patch: Partial<WarningSummary>): WarningSummary => ({
  id: '00000000-0000-4000-8000-000000000001',
  identifier: 'TJ-KCHS-1',
  title: 'Снежная лавина',
  status: 'published',
  msgType: 'Alert',
  capStatus: 'Actual',
  severity: 'Severe',
  urgency: 'Immediate',
  effective: '2026-11-04T08:00:00Z',
  expires: '2026-11-05T18:00:00Z',
  publishedAt: '2026-11-04T08:00:00Z',
  areas: ['Айни', 'Варзоб'],
  updatedAt: '2026-11-04T08:00:00Z',
  ...patch,
})

describe('полоса обстановки', () => {
  it('без действующих предупреждений полосы нет', () => {
    expect(pickSituation([], NOW)).toBeNull()
    expect(
      pickSituation(
        [
          warning({ status: 'draft' }),
          warning({ capStatus: 'Exercise' }),
          warning({ msgType: 'Cancel' }),
          warning({ expires: '2026-11-04T11:59:00Z' }),
        ],
        NOW,
      ),
    ).toBeNull()
  })

  it('слабое предупреждение (уровень 0) полосу не поднимает', () => {
    expect(pickSituation([warning({ severity: 'Minor' })], NOW)).toBeNull()
  })

  it('берёт самое строгое, при равной строгости — самое свежее, и считает все', () => {
    const items = [
      warning({ id: '00000000-0000-4000-8000-00000000000a', severity: 'Moderate' }),
      warning({ id: '00000000-0000-4000-8000-00000000000b', severity: 'Severe' }),
      warning({
        id: '00000000-0000-4000-8000-00000000000c',
        severity: 'Severe',
        publishedAt: '2026-11-04T10:00:00Z',
      }),
    ]
    const situation = pickSituation(items, NOW)
    expect(situation?.warning.id).toBe('00000000-0000-4000-8000-00000000000c')
    expect(situation?.level).toBe(2)
    expect(situation?.count).toBe(3)
  })

  it('бессрочное и с неизвестной строгостью — на виду как «внимание»', () => {
    const situation = pickSituation([warning({ severity: 'Unknown', expires: null })], NOW)
    expect(situation?.level).toBe(1)
  })
})
