import type { CalendarColor } from '@kchs/contracts'

/**
 * Цвета календарей — оттенки палитры графиков (`chart-1…10`) в обеих темах:
 * фон события — полупрозрачная заливка оттенка поверх поверхности, полоса
 * слева и точка — сам оттенок. Текст — всегда основной цвет темы: контраст
 * не зависит от выбранного цвета.
 */
export type CalendarTone = CalendarColor

interface ToneClasses {
  /** Заливка события. */
  fill: string
  /** Полоса слева и рамка «под вопросом». */
  edge: string
  /** Точка в списках и мини-календаре. */
  dot: string
  /** Рамка «ещё не ответил». */
  dashed: string
  /** Отмеченный флажок календаря в списке. */
  check: string
}

const TONES: Record<CalendarTone, ToneClasses> = {
  blue: {
    fill: 'bg-chart-1/15',
    edge: 'border-l-chart-1',
    dot: 'bg-chart-1',
    dashed: 'border-chart-1',
    check: 'data-[state=checked]:border-chart-1 data-[state=checked]:bg-chart-1',
  },
  orange: {
    fill: 'bg-chart-2/15',
    edge: 'border-l-chart-2',
    dot: 'bg-chart-2',
    dashed: 'border-chart-2',
    check: 'data-[state=checked]:border-chart-2 data-[state=checked]:bg-chart-2',
  },
  green: {
    fill: 'bg-chart-3/15',
    edge: 'border-l-chart-3',
    dot: 'bg-chart-3',
    dashed: 'border-chart-3',
    check: 'data-[state=checked]:border-chart-3 data-[state=checked]:bg-chart-3',
  },
  red: {
    fill: 'bg-chart-4/15',
    edge: 'border-l-chart-4',
    dot: 'bg-chart-4',
    dashed: 'border-chart-4',
    check: 'data-[state=checked]:border-chart-4 data-[state=checked]:bg-chart-4',
  },
  purple: {
    fill: 'bg-chart-5/15',
    edge: 'border-l-chart-5',
    dot: 'bg-chart-5',
    dashed: 'border-chart-5',
    check: 'data-[state=checked]:border-chart-5 data-[state=checked]:bg-chart-5',
  },
  teal: {
    fill: 'bg-chart-6/15',
    edge: 'border-l-chart-6',
    dot: 'bg-chart-6',
    dashed: 'border-chart-6',
    check: 'data-[state=checked]:border-chart-6 data-[state=checked]:bg-chart-6',
  },
  gold: {
    fill: 'bg-chart-7/15',
    edge: 'border-l-chart-7',
    dot: 'bg-chart-7',
    dashed: 'border-chart-7',
    check: 'data-[state=checked]:border-chart-7 data-[state=checked]:bg-chart-7',
  },
  pink: {
    fill: 'bg-chart-8/15',
    edge: 'border-l-chart-8',
    dot: 'bg-chart-8',
    dashed: 'border-chart-8',
    check: 'data-[state=checked]:border-chart-8 data-[state=checked]:bg-chart-8',
  },
  slate: {
    fill: 'bg-chart-9/15',
    edge: 'border-l-chart-9',
    dot: 'bg-chart-9',
    dashed: 'border-chart-9',
    check: 'data-[state=checked]:border-chart-9 data-[state=checked]:bg-chart-9',
  },
  brown: {
    fill: 'bg-chart-10/15',
    edge: 'border-l-chart-10',
    dot: 'bg-chart-10',
    dashed: 'border-chart-10',
    check: 'data-[state=checked]:border-chart-10 data-[state=checked]:bg-chart-10',
  },
}

export function toneClasses(tone: CalendarTone): ToneClasses {
  return TONES[tone] ?? TONES.blue
}

/**
 * Как показать событие: `solid` — подтверждено; `pending` — приглашение без
 * ответа (пунктир); `tentative` — «возможно» (штриховка); `busy` — чужое
 * закрытое, только время; `declined` — отказ (зачёркнуто); `free` — время
 * помечено свободным (прозрачнее).
 */
export type CalendarItemVariant = 'solid' | 'pending' | 'tentative' | 'busy' | 'declined' | 'free'

/** Классы события по оттенку и виду — общие для сетки времени и месяца. */
export function itemClasses(tone: CalendarTone, variant: CalendarItemVariant = 'solid'): string {
  const classes = toneClasses(tone)
  switch (variant) {
    case 'busy':
      return 'border border-line-strong border-dashed bg-surface-3 text-fg-secondary'
    case 'pending':
      return `border border-dashed ${classes.dashed} bg-surface text-fg`
    case 'tentative':
      return `border-l-[3px] ${classes.edge} ${classes.fill} kchs-calendar-hatch text-fg`
    case 'declined':
      return `border-l-[3px] ${classes.edge} bg-surface-2 text-fg-muted line-through`
    case 'free':
      return `border-l-[3px] ${classes.edge} bg-surface text-fg-secondary`
    default:
      return `border-l-[3px] ${classes.edge} ${classes.fill} text-fg`
  }
}
