import type { ClassificationMethod } from '@kchs/contracts'

/** Больше значений естественные границы не берут: равномерная по рангу выборка. */
const JENKS_SAMPLE = 2000

/** 12 значащих цифр: без хвостов плавающей точки (0.30000000000000004) в границах. */
const round = (value: number): number => Number(value.toPrecision(12))

/**
 * Границы классов по методу из `LayerStyle` (07-gis-engine.md §4):
 * `equal` — равные интервалы, `quantile` — квантили (линейная интерполяция,
 * как R-7), `jenks` — естественные границы Фишера — Дженкса (минимум суммы
 * квадратов отклонений внутри классов), `log` — равные интервалы логарифма,
 * `stddev` — шаг в одно стандартное отклонение от среднего, `manual` — границы
 * из `options.breaks`.
 *
 * Результат — края классов по возрастанию `[min, b1, …, b(k−1), max]`: класс i —
 * значения из [e(i), e(i+1)), последний включает максимум (как выражение `step`
 * MapLibre). Внутренние границы строго возрастают: совпавшие схлопываются, и
 * классов бывает меньше запрошенного; последняя может совпасть с максимумом —
 * верхний класс из одного значения. Пустые, NaN и бесконечности не учитываются;
 * нет чисел — пустой массив. Детерминирован: одинаковые входы — одинаковые границы.
 */
export function classify(
  values: Iterable<number | null | undefined>,
  method: ClassificationMethod,
  classes: number,
  options: { breaks?: readonly number[] | null } = {},
): number[] {
  if (method === 'manual') {
    const breaks = [...(options.breaks ?? [])]
      .filter(Number.isFinite)
      .map(round)
      .sort((a, b) => a - b)
    if (breaks.length < 2) return dedupe(breaks)
    const min = breaks[0] as number
    const max = breaks.at(-1) as number
    const inner = dedupe(breaks.slice(1, -1)).filter((b) => b > min && b <= max)
    return [min, ...inner, max]
  }
  const sorted = Float64Array.from(
    [...values].filter((v): v is number => typeof v === 'number' && Number.isFinite(v)),
  ).sort()
  const n = sorted.length
  if (n === 0) return []
  const min = sorted[0] as number
  const max = sorted[n - 1] as number
  if (min === max) return [round(min), round(max)]
  const k = Math.max(1, Math.min(9, Math.floor(classes)))
  let inner: number[]
  switch (method) {
    case 'equal':
      inner = equalBreaks(min, max, k)
      break
    case 'quantile':
      inner = Array.from({ length: k - 1 }, (_, i) => quantile(sorted, (i + 1) / k))
      break
    case 'jenks':
      inner = jenksBreaks(sample(sorted, JENKS_SAMPLE), k)
      break
    case 'log':
      inner = logBreaks(sorted, k)
      break
    case 'stddev':
      inner = stddevBreaks(sorted, k)
      break
  }
  // Верхний класс из одного значения (граница = максимум) сохраняется: [.., 20, 20]
  const breaks = dedupe(inner.map(round).filter((b) => b > min && b <= max))
  return [round(min), ...breaks, round(max)]
}

function dedupe(sorted: number[]): number[] {
  return sorted.filter((value, i) => i === 0 || value !== sorted[i - 1])
}

function equalBreaks(min: number, max: number, k: number): number[] {
  return Array.from({ length: k - 1 }, (_, i) => min + ((max - min) * (i + 1)) / k)
}

/** Квантиль отсортированного массива с линейной интерполяцией между рангами. */
function quantile(sorted: Float64Array, p: number): number {
  const h = (sorted.length - 1) * p
  const lo = Math.floor(h)
  const a = sorted[lo] as number
  const b = sorted[Math.min(sorted.length - 1, lo + 1)] as number
  return a + (h - lo) * (b - a)
}

/** Равномерная по рангу выборка отсортированного массива: минимум и максимум сохраняются. */
function sample(sorted: Float64Array, size: number): Float64Array {
  if (sorted.length <= size) return sorted
  return Float64Array.from(
    { length: size },
    (_, i) => sorted[Math.round((i * (sorted.length - 1)) / (size - 1))] as number,
  )
}

/**
 * Естественные границы (Fisher 1958, Jenks 1977): динамическое программирование
 * по отсортированным значениям, O(k·n²). Граница класса — его наименьшее значение.
 */
function jenksBreaks(data: Float64Array, k: number): number[] {
  const n = data.length
  const classes = Math.min(k, n)
  if (classes < 2) return []
  const width = classes + 1
  // lower[l][j] — номер (с 1) первого значения последнего из j классов для первых l значений
  const lower = new Int32Array((n + 1) * width)
  const cost = new Float64Array((n + 1) * width).fill(Number.POSITIVE_INFINITY)
  for (let j = 1; j <= classes; j += 1) {
    lower[width + j] = 1
    cost[width + j] = 0
  }
  for (let l = 2; l <= n; l += 1) {
    let sum = 0
    let sumSquares = 0
    let variance = 0
    for (let m = 1; m <= l; m += 1) {
      const first = l - m + 1
      const value = data[first - 1] as number
      sum += value
      sumSquares += value * value
      variance = sumSquares - (sum * sum) / m
      const before = first - 1
      if (before === 0) continue
      for (let j = 2; j <= classes; j += 1) {
        const candidate = variance + (cost[before * width + j - 1] as number)
        if (cost[l * width + j]! >= candidate) {
          lower[l * width + j] = first
          cost[l * width + j] = candidate
        }
      }
    }
    lower[l * width + 1] = 1
    cost[l * width + 1] = variance
  }
  const breaks: number[] = []
  let last = n
  for (let j = classes; j > 1; j -= 1) {
    const first = lower[last * width + j] as number
    breaks.unshift(data[first - 1] as number)
    last = first - 1
  }
  return breaks
}

/** Равные интервалы по log10 положительных значений; неположительные — в первом классе. */
function logBreaks(sorted: Float64Array, k: number): number[] {
  const positive = sorted.find((v) => v > 0)
  const max = sorted[sorted.length - 1] as number
  if (positive === undefined || positive === max) {
    return equalBreaks(sorted[0] as number, max, k)
  }
  const lo = Math.log10(positive)
  const hi = Math.log10(max)
  return Array.from({ length: k - 1 }, (_, i) => 10 ** (lo + ((hi - lo) * (i + 1)) / k))
}

/**
 * Шаг в одно стандартное отклонение (генеральное): при нечётном числе классов
 * средний класс — среднее ± 0,5σ, при чётном среднее — граница.
 */
function stddevBreaks(sorted: Float64Array, k: number): number[] {
  const n = sorted.length
  let mean = 0
  for (const v of sorted) mean += v / n
  let squares = 0
  for (const v of sorted) squares += (v - mean) ** 2
  const sd = Math.sqrt(squares / n)
  if (sd === 0) return []
  return Array.from({ length: k - 1 }, (_, i) => mean + (i + 1 - k / 2) * sd)
}
