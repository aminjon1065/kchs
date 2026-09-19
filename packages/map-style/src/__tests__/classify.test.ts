import { describe, expect, it } from 'vitest'
import { classify } from '../classify.js'

/** Сумма квадратов отклонений внутри классов — то, что минимизируют естественные границы. */
function withinVariance(values: number[], edges: number[]): number {
  const classes: number[][] = edges.slice(0, -1).map(() => [])
  for (const v of values) {
    let i = edges.length - 2
    while (i > 0 && v < (edges[i] as number)) i -= 1
    classes[i]?.push(v)
  }
  return classes.reduce((sum, list) => {
    if (!list.length) return sum
    const mean = list.reduce((a, b) => a + b, 0) / list.length
    return sum + list.reduce((a, b) => a + (b - mean) ** 2, 0)
  }, 0)
}

/** Перебор всех разбиений отсортированного набора на k классов: эталон для малых n. */
function bruteForceJenks(values: number[], k: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  let best = Number.POSITIVE_INFINITY
  const cut = (start: number, left: number, acc: number[]) => {
    if (left === 1) {
      const edges = [
        sorted[0] as number,
        ...acc.map((i) => sorted[i] as number),
        sorted.at(-1) as number,
      ]
      best = Math.min(best, withinVariance(sorted, edges))
      return
    }
    for (let i = start; i <= sorted.length - left + 1; i += 1) {
      if (i > 0 && sorted[i] !== sorted[i - 1]) cut(i + 1, left - 1, [...acc, i])
    }
  }
  cut(1, k, [])
  return best
}

describe('classify — границы классов', () => {
  it('равные интервалы: 0…100 на 4 класса', () => {
    expect(classify([0, 10, 55, 100], 'equal', 4)).toEqual([0, 25, 50, 75, 100])
    // Без хвостов плавающей точки
    expect(classify([0, 0.3], 'equal', 3)).toEqual([0, 0.1, 0.2, 0.3])
  })

  it('квантили — линейная интерполяция рангов (как R-7)', () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    expect(classify(values, 'quantile', 5)).toEqual([1, 2.8, 4.6, 6.4, 8.2, 10])
    expect(classify([10, 1, 5, null, undefined, Number.NaN, 3], 'quantile', 2)).toEqual([1, 4, 10])
  })

  it('квантили на повторах схлопываются: классов меньше запрошенного', () => {
    // Квантили 0,2…0,6 — единицы, 0,8 — 1,2 (между восьмым и девятым значением)
    expect(classify([1, 1, 1, 1, 1, 1, 1, 1, 2, 3], 'quantile', 5)).toEqual([1, 1.2, 3])
  })

  it('естественные границы: известный набор и оптимальность перебором', () => {
    const values = [1, 2, 4, 5, 7, 9, 10, 20]
    // Верхний класс — одно значение 20: граница совпадает с максимумом
    expect(classify(values, 'jenks', 3)).toEqual([1, 7, 20, 20])
    const edges = classify(values, 'jenks', 3)
    expect(withinVariance(values, edges)).toBeCloseTo(bruteForceJenks(values, 3), 9)

    const population = [12, 14, 15, 17, 45, 48, 52, 55, 58, 120, 125, 131, 180, 900, 950]
    for (const k of [2, 3, 4, 5]) {
      const found = classify(population, 'jenks', k)
      expect(found).toHaveLength(k + 1)
      expect(withinVariance(population, found)).toBeCloseTo(bruteForceJenks(population, k), 6)
    }
    expect(classify(population, 'jenks', 4)).toEqual([12, 45, 120, 900, 950])
  })

  it('естественные границы детерминированы и на больших наборах (выборка по рангу)', () => {
    const values = Array.from({ length: 20_000 }, (_, i) => ((i * 7919) % 10_007) + (i % 3) * 0.5)
    const first = classify(values, 'jenks', 5)
    const second = classify([...values].reverse(), 'jenks', 5)
    expect(first).toEqual(second)
    expect(first).toHaveLength(6)
    expect(first[0]).toBe(Math.min(...values))
    expect(first.at(-1)).toBe(Math.max(...values))
  })

  it('логарифм: равные интервалы по порядкам; неположительные — в первом классе', () => {
    expect(classify([1, 10, 100, 1000], 'log', 3)).toEqual([1, 10, 100, 1000])
    expect(classify([-5, 0, 1, 10, 100], 'log', 2)).toEqual([-5, 10, 100])
    // Нет положительных — равные интервалы
    expect(classify([-10, -5, 0], 'log', 2)).toEqual([-10, -5, 0])
  })

  it('стандартное отклонение: среднее 5, σ = 2', () => {
    const values = [2, 4, 4, 4, 5, 5, 7, 9]
    // Чётное число классов: среднее — граница
    expect(classify(values, 'stddev', 4)).toEqual([2, 3, 5, 7, 9])
    // Нечётное: средний класс — среднее ± 0,5σ; граница вне данных отбрасывается
    expect(classify(values, 'stddev', 5)).toEqual([2, 4, 6, 8, 9])
  })

  it('ручные границы: сортировка, повторы и нечисла отбрасываются', () => {
    expect(classify([], 'manual', 5, { breaks: [100, 0, 50, 50, Number.NaN] })).toEqual([
      0, 50, 100,
    ])
    expect(classify([1, 2, 3], 'manual', 5)).toEqual([])
    // Кэш естественных границ с верхним классом из одного значения сохраняется
    expect(classify([], 'manual', 3, { breaks: [1, 7, 20, 20] })).toEqual([1, 7, 20, 20])
  })

  it('пустые данные и одно значение', () => {
    expect(classify([], 'quantile', 5)).toEqual([])
    expect(classify([null, undefined], 'equal', 5)).toEqual([])
    expect(classify([7, 7, 7], 'jenks', 5)).toEqual([7, 7])
  })
})
