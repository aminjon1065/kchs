import { describe, expect, it } from 'vitest'
import { MapSlots } from './map-slots.js'

const live = (slots: MapSlots, ids: string[]) => ids.filter((id) => slots.isLive(id))

describe('очередь живых карт', () => {
  it('не больше предела: видимые по порядку появления, ушедшие освобождают слот', () => {
    const slots = new MapSlots(2)
    for (const id of ['a', 'b', 'c']) slots.show(id, true)
    expect(live(slots, ['a', 'b', 'c'])).toEqual(['a', 'b'])
    slots.show('a', false)
    expect(live(slots, ['a', 'b', 'c'])).toEqual(['b', 'c'])
    expect(slots.isVisible('a')).toBe(false)
  })

  it('«Показать карту» — вперёд очереди, вытесняя самую раннюю', () => {
    const slots = new MapSlots(2)
    for (const id of ['a', 'b', 'c']) slots.show(id, true)
    slots.promote('c')
    expect(live(slots, ['a', 'b', 'c'])).toEqual(['a', 'c'])
    // Невидимую плитку вперёд не поставить
    slots.promote('z')
    expect(slots.isLive('z')).toBe(false)
  })

  it('пауза (дашборд под TV-режимом) — ни одной живой карты, затем как было', () => {
    const slots = new MapSlots(4)
    const calls: number[] = []
    slots.subscribe(() => calls.push(1))
    slots.show('a', true)
    slots.setPaused(true)
    expect(slots.isLive('a')).toBe(false)
    expect(slots.isVisible('a')).toBe(true)
    slots.setPaused(false)
    expect(slots.isLive('a')).toBe(true)
    expect(calls.length).toBeGreaterThanOrEqual(3)
  })
})
