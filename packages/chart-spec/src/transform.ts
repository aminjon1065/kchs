/**
 * Преобразования данных перед отрисовкой: порядок категорий, top-N с «Прочим»,
 * корзины гистограммы, даунсэмплинг LTTB. Чистые функции без ECharts.
 */

/** Сравнение значений измерения: числа — численно, строки — по языку. */
export function compareValues(a: unknown, b: unknown, locale: string): number {
  if (a === b) return 0
  if (a === null || a === undefined) return 1
  if (b === null || b === undefined) return -1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  const na = Number(a)
  const nb = Number(b)
  if (
    typeof a !== 'boolean' &&
    typeof b !== 'boolean' &&
    String(a).trim() !== '' &&
    String(b).trim() !== '' &&
    Number.isFinite(na) &&
    Number.isFinite(nb)
  ) {
    return na - nb
  }
  return String(a).localeCompare(String(b), locale, { numeric: true, sensitivity: 'base' })
}

export interface TopN<K> {
  kept: K[]
  folded: K[]
}

/**
 * Первые `limit` ключей по весу (по убыванию модуля), остальные — в «Прочее».
 * Порядок оставшихся ключей сохраняется исходным.
 */
export function topN<K>(keys: readonly K[], weight: (key: K) => number, limit: number): TopN<K> {
  if (keys.length <= limit) return { kept: [...keys], folded: [] }
  const ranked = keys
    .map((key, i) => ({ key, i, w: Math.abs(weight(key)) }))
    .sort((a, b) => b.w - a.w || a.i - b.i)
  const keep = new Set(ranked.slice(0, limit).map((r) => r.key))
  return {
    kept: keys.filter((k) => keep.has(k)),
    folded: keys.filter((k) => !keep.has(k)),
  }
}

// ─── Гистограмма ─────────────────────────────────────────────────────────────

/** «Круглый» шаг 1, 2, 2.5, 5 × 10ⁿ не меньше заданного. */
export function niceStep(raw: number): number {
  if (!(raw > 0) || !Number.isFinite(raw)) return 1
  const power = 10 ** Math.floor(Math.log10(raw))
  const f = raw / power
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10
  return nice * power
}

export interface Bin {
  from: number
  to: number
  count: number
}

/**
 * Корзины гистограммы: число по правилу Фридмана — Диакониса (Стёрджеса для
 * малых выборок), 5…40 корзин, шаг округлён до «круглого», границы кратны шагу.
 * Правая граница последней корзины включена.
 */
export function histogramBins(values: readonly number[], target?: number): Bin[] {
  const data = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
  if (data.length === 0) return []
  const min = data[0] as number
  const max = data[data.length - 1] as number
  if (min === max) return [{ from: min, to: min, count: data.length }]
  let count = target
  if (!count) {
    const q = (p: number) => data[Math.floor(p * (data.length - 1))] as number
    const iqr = q(0.75) - q(0.25)
    const fd = iqr > 0 ? (max - min) / (2 * iqr * data.length ** (-1 / 3)) : 0
    const sturges = Math.ceil(Math.log2(data.length) + 1)
    count = data.length >= 30 && fd > 0 ? Math.ceil(fd) : sturges
  }
  count = Math.min(40, Math.max(5, count))
  const step = niceStep((max - min) / count)
  const start = Math.floor(min / step) * step
  // Шаг с плавающей точкой даёт 0.30000000000000004 — границы округляются
  const round = (v: number) => Number(v.toPrecision(12))
  const n = Math.min(200, Math.max(1, Math.ceil(round((max - start) / step))))
  const bins: Bin[] = []
  for (let i = 0; i < n; i += 1) {
    bins.push({ from: round(start + i * step), to: round(start + (i + 1) * step), count: 0 })
  }
  for (const v of data) {
    const i = Math.min(n - 1, Math.floor(round((v - start) / step)))
    ;(bins[i] as Bin).count += 1
  }
  return bins
}

// ─── LTTB ────────────────────────────────────────────────────────────────────

/**
 * Largest-Triangle-Three-Buckets: оставляет `threshold` точек ряда, сохраняя
 * форму линии (пики и провалы). Точки отсортированы по x. Возвращает индексы.
 */
export function lttb(xs: readonly number[], ys: readonly number[], threshold: number): number[] {
  const n = xs.length
  if (threshold >= n || threshold < 3) return xs.map((_, i) => i)
  const out: number[] = [0]
  const every = (n - 2) / (threshold - 2)
  let a = 0
  for (let i = 0; i < threshold - 2; i += 1) {
    // Среднее следующей корзины — вершина треугольника
    let avgX = 0
    let avgY = 0
    const nextStart = Math.floor((i + 1) * every) + 1
    const nextEnd = Math.min(n, Math.floor((i + 2) * every) + 1)
    const nextLen = Math.max(1, nextEnd - nextStart)
    for (let j = nextStart; j < nextEnd; j += 1) {
      avgX += xs[j] as number
      avgY += ys[j] as number
    }
    avgX /= nextLen
    avgY /= nextLen

    const start = Math.floor(i * every) + 1
    const end = Math.floor((i + 1) * every) + 1
    const ax = xs[a] as number
    const ay = ys[a] as number
    let best = start
    let bestArea = -1
    for (let j = start; j < end; j += 1) {
      const area = Math.abs(
        (ax - avgX) * ((ys[j] as number) - ay) - (ax - (xs[j] as number)) * (avgY - ay),
      )
      if (area > bestArea) {
        bestArea = area
        best = j
      }
    }
    out.push(best)
    a = best
  }
  out.push(n - 1)
  return out
}
