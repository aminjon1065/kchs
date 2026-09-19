import type { LayerRecord } from '@kchs/contracts'
import { describe, expect, it } from 'vitest'
import {
  addSteps,
  coerceWindow,
  floorStep,
  formatWindow,
  frameInterval,
  initialWindow,
  nextWindow,
  playbackStart,
  previousWindow,
  timeLayers,
  timeScale,
  timeSettings,
  timeWindow,
  wallFromValue,
  wallOf,
  windowTime,
} from './time-model.js'

const wall = (text: string) => Date.parse(`${text}Z`)

describe('шкала времени: настенное время и шаги', () => {
  it('дата-время из результата — в поясе пользователя, дата — календарный день', () => {
    // Душанбе: UTC+5 — вечер 1 марта по UTC уже 2 марта по местному времени
    expect(wallFromValue('2026-03-01T19:30:00.000Z', 'Asia/Dushanbe')).toBe(
      wall('2026-03-02T00:30:00'),
    )
    expect(wallFromValue('2026-03-01', 'Asia/Dushanbe')).toBe(wall('2026-03-01T00:00:00'))
    expect(wallFromValue('2026-03-01T14:30:00', 'Asia/Dushanbe')).toBe(wall('2026-03-01T14:30:00'))
    expect(wallFromValue(null, 'UTC')).toBeNull()
    expect(wallOf(Date.parse('2026-07-01T00:00:00Z'), 'Europe/Berlin')).toBe(
      wall('2026-07-01T02:00:00'),
    )
  })

  it('начало шага: час, сутки, неделя с понедельника, месяц, год', () => {
    const t = wall('2026-03-04T15:42:10')
    expect(floorStep(t, 'hour')).toBe(wall('2026-03-04T15:00:00'))
    expect(floorStep(t, 'day')).toBe(wall('2026-03-04T00:00:00'))
    expect(floorStep(t, 'week')).toBe(wall('2026-03-02T00:00:00'))
    expect(floorStep(t, 'month')).toBe(wall('2026-03-01T00:00:00'))
    expect(floorStep(t, 'year')).toBe(wall('2026-01-01T00:00:00'))
    expect(addSteps(wall('2026-01-01T00:00:00'), 'month', 13)).toBe(wall('2027-02-01T00:00:00'))
    expect(addSteps(wall('2026-03-02T00:00:00'), 'week', -1)).toBe(wall('2026-02-23T00:00:00'))
  })

  it('число шагов над диапазоном данных', () => {
    const domain = { min: wall('2026-03-01T10:00:00'), max: wall('2026-05-02T08:00:00') }
    expect(timeScale(domain, 'month')).toEqual({ origin: wall('2026-03-01T00:00:00'), count: 3 })
    expect(timeScale(domain, 'day').count).toBe(63)
    expect(timeScale(domain, 'year').count).toBe(1)
    expect(timeScale({ min: domain.min, max: domain.min }, 'hour').count).toBe(1)
  })
})

describe('окно шкалы → интервал тайлов `t`', () => {
  const origin = wall('2026-03-01T00:00:00')

  it('сутки и месяцы — даты включительно, часы — местное время до конца часа', () => {
    expect(windowTime({ start: 0, end: 30 }, origin, 'day', 'range')).toEqual({
      from: '2026-03-01',
      to: '2026-03-31',
      mode: 'range',
      step: 'day',
    })
    expect(windowTime({ start: 1, end: 1 }, origin, 'month', 'instant')).toMatchObject({
      from: '2026-04-01',
      to: '2026-04-30',
    })
    expect(
      windowTime({ start: 0, end: 0 }, wall('2026-03-01T14:00:00'), 'hour', 'instant'),
    ).toMatchObject({ from: '2026-03-01T14:00:00.000', to: '2026-03-01T14:59:59.999' })
    expect(
      windowTime({ start: 0, end: 0 }, wall('2026-03-02T00:00:00'), 'week', 'instant'),
    ).toMatchObject({
      from: '2026-03-02',
      to: '2026-03-08',
    })
  })

  it('интервал карты обратно в окно — по шагам его концов, в пределах шкалы', () => {
    expect(timeWindow({ from: '2026-03-01', to: '2026-03-31' }, origin, 'day', 63)).toEqual({
      start: 0,
      end: 30,
    })
    expect(timeWindow({ from: '2026-04-01', to: '2026-04-30' }, origin, 'month', 3)).toEqual({
      start: 1,
      end: 1,
    })
    expect(timeWindow({ from: '2025-01-01', to: '2030-01-01' }, origin, 'month', 3)).toEqual({
      start: 0,
      end: 2,
    })
    expect(timeWindow({ from: 'вчера', to: '2026-03-01' }, origin, 'day', 3)).toBeNull()
  })
})

describe('воспроизведение и режимы', () => {
  it('диапазон сдвигается целиком, момент — на шаг, накопление растёт от начала', () => {
    expect(nextWindow({ start: 2, end: 4 }, 'range', 10)).toEqual({ start: 3, end: 5 })
    expect(nextWindow({ start: 5, end: 9 }, 'range', 10)).toBeNull()
    expect(nextWindow({ start: 3, end: 3 }, 'instant', 10)).toEqual({ start: 4, end: 4 })
    expect(nextWindow({ start: 0, end: 3 }, 'cumulative', 10)).toEqual({ start: 0, end: 4 })
    expect(previousWindow({ start: 3, end: 5 }, 'range')).toEqual({ start: 2, end: 4 })
    expect(previousWindow({ start: 0, end: 0 }, 'instant')).toBeNull()
    expect(previousWindow({ start: 0, end: 4 }, 'cumulative')).toEqual({ start: 0, end: 3 })
  })

  it('старт: с конца — сначала, диапазон во все данные — один шаг', () => {
    expect(playbackStart({ start: 0, end: 9 }, 'range', 10)).toEqual({ start: 0, end: 0 })
    expect(playbackStart({ start: 7, end: 9 }, 'range', 10)).toEqual({ start: 0, end: 2 })
    expect(playbackStart({ start: 9, end: 9 }, 'instant', 10)).toEqual({ start: 0, end: 0 })
    expect(playbackStart({ start: 4, end: 4 }, 'instant', 10)).toEqual({ start: 4, end: 4 })
    expect(initialWindow('range', 10)).toEqual({ start: 0, end: 9 })
    expect(initialWindow('cumulative', 10)).toEqual({ start: 0, end: 0 })
    expect(coerceWindow({ start: 3, end: 6 }, 'instant')).toEqual({ start: 3, end: 3 })
    expect(coerceWindow({ start: 3, end: 6 }, 'cumulative')).toEqual({ start: 0, end: 6 })
    expect(frameInterval(2)).toBe(600)
  })

  it('слои со временем и режим по умолчанию — первого слоя', () => {
    const layer = (time: unknown, extra: Partial<LayerRecord> = {}) =>
      ({ style: { time }, dataAccess: true, ...extra }) as unknown as LayerRecord
    const timed = layer({ field: 'day', mode: 'instant', step: 'month' })
    const rows = [
      { layer: layer(null), entry: { visible: true } },
      { layer: timed, entry: { visible: true } },
      { layer: layer({ field: 'day', mode: 'range', step: 'day' }), entry: { visible: false } },
      { layer: layer({ field: 'day' }, { dataAccess: false }), entry: { visible: true } },
      { layer: null, entry: { visible: true } },
    ]
    expect(timeLayers(rows)).toEqual([timed])
    expect(timeSettings(null, [timed])).toEqual({ mode: 'instant', step: 'month' })
    expect(
      timeSettings({ from: '2026-01-01', to: '2026-01-01', mode: 'cumulative', step: 'year' }, [
        timed,
      ]),
    ).toEqual({ mode: 'cumulative', step: 'year' })
    expect(timeSettings(null, [])).toEqual({ mode: 'range', step: 'day' })
  })

  it('подписи окна: месяц словом, неделя — её дни, один день — одна подпись', () => {
    const origin = wall('2026-03-01T00:00:00')
    const month = formatWindow({ start: 0, end: 1 }, origin, 'month', 'ru')
    expect(month.from).toContain('март')
    expect(month.to).toContain('апрель')
    expect(formatWindow({ start: 0, end: 0 }, origin, 'day', 'ru').to).toBeNull()
    const week = formatWindow({ start: 0, end: 0 }, wall('2026-03-02T00:00:00'), 'week', 'en')
    expect(week.from).toContain('Mar 2')
    expect(week.to).toContain('Mar 8')
  })
})
