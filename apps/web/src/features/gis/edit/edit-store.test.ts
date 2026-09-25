import type { FeatureGeometry } from '@kchs/contracts'
import { describe, expect, it } from 'vitest'
import { disposeEditStore, editStore } from './edit-store.js'

const point = (x: number): FeatureGeometry => ({ type: 'Point', coordinates: [x, 38] })
const target = { rowId: null, ver: null, values: {}, original: null, geometryLocked: false }

describe('история черновика (ADR-0160)', () => {
  it('отмена и повтор шагают по правкам; новая правка забывает отменённое', () => {
    const store = editStore('map-undo')
    const state = () => store.getState()
    state().start('layer')
    state().open(target, point(1), {})
    expect(state().undo()).toBeUndefined()

    state().setGeometry(point(2))
    state().setGeometry(point(3))
    // Та же геометрия — не шаг истории
    state().setGeometry(point(3))
    expect(state().past).toHaveLength(2)

    expect(state().undo()).toEqual(point(2))
    expect(state().undo()).toEqual(point(1))
    expect(state().undo()).toBeUndefined()
    expect(state().geometry).toEqual(point(1))
    expect(state().redo()).toEqual(point(2))

    state().setGeometry(point(5))
    expect(state().future).toEqual([])
    expect(state().redo()).toBeUndefined()
    expect(state().undo()).toEqual(point(2))

    // Новый объект — история с чистого листа
    state().open(target, point(9), {})
    expect(state().past).toEqual([])
    expect(state().future).toEqual([])
    disposeEditStore('map-undo')
  })
})
