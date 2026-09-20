import { describe, expect, it } from 'vitest'
import { diffText, tokenize } from './text-diff.js'

/** Текст «было» и «стало» из сегментов сравнения. */
function sides(segments: Array<{ op: string; text: string }>) {
  return {
    from: segments
      .filter((segment) => segment.op !== 'insert')
      .map((segment) => segment.text)
      .join(''),
    to: segments
      .filter((segment) => segment.op !== 'delete')
      .map((segment) => segment.text)
      .join(''),
  }
}

/** Детерминированный генератор для проверки на случайных правках. */
function random(seed: number) {
  let state = seed
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648
    return state / 2_147_483_648
  }
}

describe('сравнение текста по словам', () => {
  it('слова и промежутки — отдельные лексемы', () => {
    expect(tokenize('Прошу  выделить\nтри')).toEqual(['Прошу', '  ', 'выделить', '\n', 'три'])
  })

  it('добавленное и удалённое — по словам, общее — без изменений', () => {
    const result = diffText(
      'Прошу выделить три машины для вывоза населения',
      'Прошу срочно выделить пять машин для вывоза населения',
    )
    expect(result.stats).toEqual({ inserted: 3, deleted: 2, unchanged: 5 })
    expect(
      result.segments.filter((segment) => segment.op === 'delete').map((s) => s.text.trim()),
    ).toEqual(['три машины'])
    expect(sides(result.segments).to).toBe('Прошу срочно выделить пять машин для вывоза населения')
  })

  it('одинаковые тексты — один сегмент без изменений', () => {
    const result = diffText('Текст письма', 'Текст письма')
    expect(result.segments).toEqual([{ op: 'equal', text: 'Текст письма' }])
    expect(result.stats).toEqual({ inserted: 0, deleted: 0, unchanged: 2 })
  })

  it('пустые стороны', () => {
    expect(diffText('', 'новый текст').segments).toEqual([{ op: 'insert', text: 'новый текст' }])
    expect(diffText('старый текст', '').segments).toEqual([{ op: 'delete', text: 'старый текст' }])
    expect(diffText('', '').segments).toEqual([])
  })

  it('промежутки разного вида не считаются правкой', () => {
    const result = diffText('Прошу выделить', 'Прошу\nвыделить')
    expect(result.stats).toEqual({ inserted: 0, deleted: 0, unchanged: 2 })
  })

  it('на случайных правках восстанавливает обе стороны и минимален по сравнению с заменой', () => {
    const words = ['паводок', 'район', 'машины', 'срочно', 'население', 'сводка', 'Хатлон']
    const next = random(42)
    for (let round = 0; round < 60; round += 1) {
      const base = Array.from(
        { length: 5 + Math.floor(next() * 30) },
        () => words[Math.floor(next() * words.length)],
      )
      const changed = base.flatMap((word) => {
        const roll = next()
        if (roll < 0.1) return []
        if (roll < 0.2) return [word, words[Math.floor(next() * words.length)] ?? 'x']
        if (roll < 0.3) return [words[Math.floor(next() * words.length)] ?? 'y']
        return [word]
      })
      const from = base.join(' ')
      const to = changed.join(' ')
      const result = diffText(from, to)
      expect(sides(result.segments)).toEqual({ from, to })
      expect(result.stats.inserted + result.stats.deleted).toBeLessThanOrEqual(
        base.length + changed.length,
      )
    }
  })

  it('больше maxEdits различий — середина целиком: удалено и добавлено', () => {
    const result = diffText('a b c d e f', 'u v w x y z', 3)
    expect(result.segments.map((segment) => segment.op)).toEqual(['delete', 'insert'])
    expect(sides(result.segments)).toEqual({ from: 'a b c d e f', to: 'u v w x y z' })
  })
})
