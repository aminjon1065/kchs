import { describe, expect, it } from 'vitest'
import {
  minutesLeft,
  populationOf,
  populationSourceOf,
  totalPopulation,
  warningChecks,
} from './warning-checks.js'

const filled = (headline = 'Лавинная опасность') => ({
  event: 'Лавина',
  headline,
  description: 'Высока вероятность схода лавин',
  instruction: '',
})

const NOW = Date.parse('2026-11-05T09:00:00Z')

describe('проверка перед подписью', () => {
  it('всё готово: четыре проверки пройдены, категории и подписывающего нет в списке', () => {
    const result = warningChecks(
      {
        info: { tg: filled(), ru: filled(), en: filled() },
        categories: ['Geo'],
        areas: [{}],
        expires: '2026-11-06T13:00:00Z',
        signerId: 'signer',
      },
      NOW,
    )
    expect(result.checks.map((check) => `${check.key}:${check.state}`)).toEqual([
      'languages:ok',
      'areas:ok',
      'headline:ok',
      'expires:ok',
    ])
    expect(result.missingLanguages).toEqual([])
  })

  it('английский по желанию, как у сервера: без него языки в порядке', () => {
    const result = warningChecks(
      {
        info: { tg: filled(), ru: filled() },
        categories: ['Geo'],
        areas: [{}],
        expires: '2026-11-06T13:00:00Z',
        signerId: 'signer',
      },
      NOW,
    )
    expect(result.checks[0]).toEqual({ key: 'languages', state: 'ok' })
    expect(result.missingLanguages).toEqual(['en'])
  })

  it('черновик: нет русского, областей, срока, категории и подписывающего', () => {
    const result = warningChecks(
      { info: { tg: filled() }, categories: [], areas: [], expires: null, signerId: null },
      NOW,
    )
    expect(
      result.checks.filter((check) => check.state === 'missing').map((check) => check.key),
    ).toEqual(['languages', 'areas', 'expires', 'categories', 'signer'])
    expect(result.missingLanguages).toEqual(['ru', 'en'])
  })

  it('истёкший срок и длинный заголовок не проходят', () => {
    const result = warningChecks(
      {
        info: { tg: filled('я'.repeat(161)), ru: filled() },
        categories: ['Geo'],
        areas: [{}],
        expires: '2026-11-05T08:00:00Z',
        signerId: 'signer',
      },
      NOW,
    )
    expect(result.expired).toBe(true)
    expect(result.longHeadlines).toEqual(['tg'])
    expect(result.checks.find((check) => check.key === 'expires')?.state).toBe('missing')
    expect(result.checks.find((check) => check.key === 'headline')?.state).toBe('missing')
  })
})

describe('население и срок', () => {
  it('сумма — только если известно у всех территорий', () => {
    expect(totalPopulation([93_800, 93_000])).toBe(186_800)
    expect(totalPopulation([93_800, null])).toBeNull()
    expect(totalPopulation([])).toBeNull()
  })

  it('численность и источник — из атрибутов справочника', () => {
    expect(populationOf({ population: 93_800 })).toBe(93_800)
    expect(populationOf({ population: '93800' })).toBe(93_800)
    expect(populationOf({ population: 'нет данных' })).toBeNull()
    expect(populationOf(undefined)).toBeNull()
    expect(
      populationSourceOf({ population_source: { source: 'Ежегодник', date: '2024-01-01' } }),
    ).toBe('Ежегодник')
    expect(populationSourceOf({})).toBeNull()
  })

  it('минуты до срока решения; просроченное — с минусом', () => {
    expect(minutesLeft('2026-11-05T09:42:00Z', NOW)).toBe(42)
    expect(minutesLeft('2026-11-05T08:50:00Z', NOW)).toBe(-10)
    expect(minutesLeft(null, NOW)).toBeNull()
  })
})
