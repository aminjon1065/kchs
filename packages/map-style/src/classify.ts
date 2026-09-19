import type { ClassificationMethod } from '@kchs/contracts'

/** Больше значений естественные границы не берут: равномерная по рангу выборка. */
const JENKS_SAMPLE = 2000

/** 12 значащих цифр: без хвостов плавающей точки (0.30000000000000004) в границах. */
const round = (value: number): number => Number(value.toPrecision(12))

/**
 * Сводка значений поля: то, что сервер считает агрегатами по всем строкам слоя с
 * политиками смотрящего (ADR-0075), — или всё, что знает клиент о выборке.
 */
export interface ValueSummary {
  min: number
  max: number
  /** Среднее и стандартное отклонение (генеральное) — метод `stddev`. */
  mean?: number | null
  stddev?: number | null
  /** Наименьшее положительное значение — метод `log`; null — положительных нет. */
  minPositive?: number | null
  /**
   * Значения для методов по рангам (`quantile`, `jenks`): все значения поля или
   * выборка крупного слоя. Порядок не важен.
   */
  sample?: Iterable<number> | null
}

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
  if (method === 'manual') return manualEdges(options.breaks)
  const sorted = Float64Array.from(
    [...values].filter((v): v is number => typeof v === 'number' && Number.isFinite(v)),
  ).sort()
  const n = sorted.length
  if (n === 0) return []
  const summary: ValueSummary = {
    min: sorted[0] as number,
    max: sorted[n - 1] as number,
    sample: sorted,
  }
  if (method === 'log') summary.minPositive = sorted.find((v) => v > 0) ?? null
  if (method === 'stddev') Object.assign(summary, moments(sorted))
  return classifySummary(summary, method, classes)
}

/**
 * Границы классов по сводке значений — те же формулы, что у `classify`: сервер
 * считает минимум, максимум, моменты и выборку по всем строкам слоя, а края
 * классов строит этот же код (ADR-0075). Нет сводки нужного метода (моментов
 * для `stddev`, выборки для `quantile` и `jenks`) — равные интервалы.
 */
export function classifySummary(
  summary: ValueSummary,
  method: ClassificationMethod,
  classes: number,
  options: { breaks?: readonly number[] | null } = {},
): number[] {
  if (method === 'manual') return manualEdges(options.breaks)
  const { min, max } = summary
  if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) return []
  if (min === max) return [round(min), round(max)]
  const k = Math.max(1, Math.min(9, Math.floor(classes)))
  const ranked = (): Float64Array | null => {
    if (!summary.sample) return null
    const sorted = Float64Array.from(
      [...summary.sample].filter((v) => typeof v === 'number' && Number.isFinite(v)),
    ).sort()
    return sorted.length > 0 ? sorted : null
  }
  let inner: number[]
  switch (method) {
    case 'equal':
      inner = equalBreaks(min, max, k)
      break
    case 'quantile': {
      const sorted = ranked()
      inner = sorted
        ? Array.from({ length: k - 1 }, (_, i) => quantile(sorted, (i + 1) / k))
        : equalBreaks(min, max, k)
      break
    }
    case 'jenks': {
      const sorted = ranked()
      inner = sorted ? jenksBreaks(sample(sorted, JENKS_SAMPLE), k) : equalBreaks(min, max, k)
      break
    }
    case 'log':
      inner = logBreaks(min, max, summary.minPositive ?? null, k)
      break
    case 'stddev':
      inner =
        summary.mean === null ||
        summary.mean === undefined ||
        summary.stddev === null ||
        summary.stddev === undefined
          ? equalBreaks(min, max, k)
          : stddevBreaks(summary.mean, summary.stddev, k)
      break
  }
  // Верхний класс из одного значения (граница = максимум) сохраняется: [.., 20, 20]
  const breaks = dedupe(inner.map(round).filter((b) => b > min && b <= max))
  return [round(min), ...breaks, round(max)]
}

/** Ручные границы: сортировка, повторы и нечисла отбрасываются. */
function manualEdges(input: readonly number[] | null | undefined): number[] {
  const breaks = [...(input ?? [])]
    .filter(Number.isFinite)
    .map(round)
    .sort((a, b) => a - b)
  if (breaks.length < 2) return dedupe(breaks)
  const min = breaks[0] as number
  const max = breaks.at(-1) as number
  const inner = dedupe(breaks.slice(1, -1)).filter((b) => b > min && b <= max)
  return [min, ...inner, max]
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
  // Одно значение — только один класс: состояния «классов больше, чем значений»
  // недостижимы (бесконечная цена), иначе при равных значениях путь назад уходил за начало
  lower[width + 1] = 1
  cost[width + 1] = 0
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
function logBreaks(min: number, max: number, positive: number | null, k: number): number[] {
  if (positive === null || positive === max) return equalBreaks(min, max, k)
  const lo = Math.log10(positive)
  const hi = Math.log10(max)
  return Array.from({ length: k - 1 }, (_, i) => 10 ** (lo + ((hi - lo) * (i + 1)) / k))
}

/** Среднее и стандартное отклонение (генеральное) отсортированных значений. */
function moments(sorted: Float64Array): { mean: number; stddev: number } {
  const n = sorted.length
  let mean = 0
  for (const v of sorted) mean += v / n
  let squares = 0
  for (const v of sorted) squares += (v - mean) ** 2
  return { mean, stddev: Math.sqrt(squares / n) }
}

/**
 * Шаг в одно стандартное отклонение: при нечётном числе классов средний класс —
 * среднее ± 0,5σ, при чётном среднее — граница.
 */
function stddevBreaks(mean: number, sd: number, k: number): number[] {
  if (!(sd > 0)) return []
  return Array.from({ length: k - 1 }, (_, i) => mean + (i + 1 - k / 2) * sd)
}
