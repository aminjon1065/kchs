import type {
  EChartsOption,
  GridComponentOption,
  LegendComponentOption,
  MarkLineComponentOption,
} from 'echarts'
import type { Ctx } from './model.js'
import type { ChartColorToken } from './theme.js'

/**
 * Настройки оси. Типы ECharts различают x и y (position), а построители
 * делают оси для обеих ролей (горизонтальные столбцы меняют их местами), поэтому
 * здесь — простой объект, типизация проверяется на сборке опции.
 */
export type AxisOption = Record<string, unknown>

/** Ключ сложенного «Прочего» — не пересекается с данными. */
export const OTHER_KEY = `${String.fromCharCode(0)}other`

/** Серий на график: 7 сущностей + «Прочее» (палитра — 8 оттенков, без повторов). */
export const MAX_SERIES = 8

/** Общие настройки: прозрачный фон, шрифт интерфейса, анимация, время в UTC. */
export function baseOption(ctx: Ctx): EChartsOption {
  const { theme } = ctx
  return {
    backgroundColor: 'transparent',
    // Моменты уже приведены к настенному времени пояса платформы
    useUTC: true,
    animation: ctx.animation,
    animationDuration: 300,
    animationDurationUpdate: 200,
    animationEasing: 'cubicOut',
    textStyle: { fontFamily: theme.fontFamily, color: theme.textSecondary, fontSize: 12 },
    // Описание для экранных дикторов даёт компонент (aria-label), ECharts его не пишет;
    // текстуры заливок — по запросу (печать, цветослепота)
    aria: { enabled: ctx.decal, label: { enabled: false }, decal: { show: ctx.decal } },
  }
}

/**
 * Цвет закреплён за сущностью: сначала места из домена (первые 8 значений
 * справочника), остальным — свободные места по порядку появления. «Прочее» —
 * всегда приглушённый серо-синий. Оттенки не повторяются.
 */
export function colorAssigner(ctx: Ctx, keys: readonly string[]): (key: string) => string {
  const { categorical, other } = ctx.theme
  const slots = new Map<string, number>()
  const used = new Set<number>()
  const domain = ctx.colorDomain
  if (domain) {
    for (const key of keys) {
      const i = domain.indexOf(key)
      if (i >= 0 && i < categorical.length && !used.has(i)) {
        slots.set(key, i)
        used.add(i)
      }
    }
  }
  let next = 0
  for (const key of keys) {
    if (key === OTHER_KEY || slots.has(key)) continue
    while (used.has(next)) next += 1
    if (next >= categorical.length) break
    slots.set(key, next)
    used.add(next)
  }
  return (key) => {
    const slot = slots.get(key)
    return slot === undefined ? other : (categorical[slot] as string)
  }
}

export function tokenColor(ctx: Ctx, token: ChartColorToken | undefined): string | undefined {
  return token ? ctx.theme.tokens[token] : undefined
}

export interface Frame {
  legend: boolean
  /** Место справа под подписи концов линий. */
  endLabels?: number
  /** Место сверху под подписи аннотаций. */
  annotations?: boolean
  /** Имена осей (combo) — место сверху. */
  axisNames?: boolean
}

/** Легенда: только для двух и более серий; чипы, цвет текста — вторичный. */
export function legendOption(ctx: Ctx, show: boolean): LegendComponentOption | undefined {
  if (!show || !ctx.spec.options.legend.show) return undefined
  const { theme } = ctx
  const position = ctx.spec.options.legend.position
  const vertical = position === 'left' || position === 'right'
  return {
    type: 'scroll',
    orient: vertical ? 'vertical' : 'horizontal',
    ...(position === 'top' ? { top: 0, left: 'center' } : {}),
    ...(position === 'bottom' ? { bottom: 0, left: 'center' } : {}),
    ...(position === 'left' ? { left: 0, top: 'middle' } : {}),
    ...(position === 'right' ? { right: 0, top: 'middle' } : {}),
    icon: 'roundRect',
    itemWidth: 10,
    itemHeight: 10,
    itemGap: 16,
    textStyle: { color: theme.textSecondary, fontSize: 12, fontFamily: theme.fontFamily },
    inactiveColor: theme.textMuted,
    pageIconColor: theme.textSecondary,
    pageIconInactiveColor: theme.grid,
    pageTextStyle: { color: theme.textSecondary },
  }
}

/** Поля области построения: подписи осей держит сам ECharts (outerBounds). */
export function gridOption(ctx: Ctx, frame: Frame): GridComponentOption {
  const position = ctx.spec.options.legend.position
  const legend = frame.legend && ctx.spec.options.legend.show
  return {
    left: legend && position === 'left' ? 132 : 4,
    right: Math.max(legend && position === 'right' ? 132 : 16, frame.endLabels ?? 0),
    top: (legend && position === 'top' ? 36 : 12) + (frame.annotations || frame.axisNames ? 20 : 0),
    bottom: legend && position === 'bottom' ? 36 : 4,
    outerBoundsMode: 'same',
    outerBoundsContain: 'all',
  }
}

/** Ось значений: сплошная тонкая сетка, без линии оси и засечек. */
export function valueAxis(
  ctx: Ctx,
  options: {
    format: (value: number) => string
    min?: number
    max?: number
    log?: boolean
    grid?: boolean
    name?: string
    position?: 'left' | 'right' | 'top' | 'bottom'
    zeroBased?: boolean
  },
): AxisOption {
  const { theme } = ctx
  return {
    type: options.log ? 'log' : 'value',
    ...(options.position ? { position: options.position } : {}),
    ...(options.min !== undefined ? { min: options.min } : {}),
    ...(options.max !== undefined ? { max: options.max } : {}),
    ...(options.zeroBased === false ? { scale: true } : {}),
    axisLine: { show: false },
    axisTick: { show: false },
    splitLine: {
      show: options.grid ?? true,
      lineStyle: { color: theme.grid, width: 1, type: 'solid' },
    },
    axisLabel: {
      color: theme.textSecondary,
      fontSize: 12,
      hideOverlap: true,
      formatter: (value: number) => options.format(value),
    },
    ...(options.name
      ? {
          name: options.name,
          nameLocation: 'end',
          nameGap: 12,
          nameTextStyle: { color: theme.textMuted, fontSize: 11, align: 'center' },
        }
      : {}),
  }
}

/** Ось категорий: линия оси — `--border-strong`, без засечек и сетки. */
export function categoryAxis(
  ctx: Ctx,
  labels: readonly string[],
  options: { horizontal?: boolean; boundaryGap?: boolean; grid?: boolean; name?: string },
): AxisOption {
  const { theme } = ctx
  return {
    type: 'category',
    data: [...labels],
    boundaryGap: options.boundaryGap ?? true,
    ...(options.horizontal ? { inverse: true } : {}),
    axisLine: { show: true, lineStyle: { color: theme.axis, width: 1 } },
    axisTick: { show: false },
    splitLine: { show: options.grid ?? false, lineStyle: { color: theme.grid, width: 1 } },
    axisLabel: {
      color: theme.textSecondary,
      fontSize: 12,
      hideOverlap: true,
      ...(options.horizontal
        ? { width: 140, overflow: 'truncate' }
        : { width: 96, overflow: 'truncate' }),
    },
    ...(options.name
      ? {
          name: options.name,
          nameTextStyle: { color: theme.textMuted, fontSize: 11 },
        }
      : {}),
  }
}

/** Ось времени (настенное время в UTC) с иерархическими подписями. */
export function timeAxis(
  ctx: Ctx,
  format: (value: number, first: boolean) => string,
  options: { grid?: boolean },
): AxisOption {
  const { theme } = ctx
  return {
    type: 'time',
    boundaryGap: false,
    axisLine: { show: true, lineStyle: { color: theme.axis, width: 1 } },
    axisTick: { show: false },
    splitLine: { show: options.grid ?? false, lineStyle: { color: theme.grid, width: 1 } },
    axisLabel: {
      color: theme.textSecondary,
      fontSize: 12,
      hideOverlap: true,
      formatter: (value: number, index: number) => format(value, index === 0),
    },
  }
}

type MarkLineItem = NonNullable<MarkLineComponentOption['data']>[number]

/**
 * Опорные линии и аннотации — markLine первой серии. Подписи — текстовыми
 * токенами (не цветом линии), линии тонкие; цвет линии — из токена спецификации.
 */
export function markLines(
  ctx: Ctx,
  items: Array<{
    axis: 'x' | 'y'
    value: number | string
    label?: string
    style: 'solid' | 'dashed' | 'dotted'
    color: string
  }>,
): MarkLineComponentOption | undefined {
  if (items.length === 0) return undefined
  const { theme } = ctx
  return {
    silent: true,
    symbol: 'none',
    animation: false,
    data: items.map(
      (item) =>
        ({
          ...(item.axis === 'y' ? { yAxis: item.value } : { xAxis: item.value }),
          lineStyle: { color: item.color, width: 1, type: item.style },
          label: item.label
            ? {
                show: true,
                // Функция, не шаблон: фигурные скобки в подписи — просто текст
                formatter: () => item.label as string,
                position: item.axis === 'y' ? 'insideEndTop' : 'end',
                color: theme.textSecondary,
                fontSize: 11,
              }
            : { show: false },
        }) as MarkLineItem,
    ),
  }
}
