import type { TooltipComponentOption } from 'echarts'
import type { Ctx } from './model.js'

/**
 * Тултипы графиков. ECharts вставляет содержимое через innerHTML, поэтому:
 * 1) любые данные экранируются (подписи категорий приходят от пользователей);
 * 2) никаких атрибутов style — строгая CSP (ADR-0043) их заблокирует: оформление
 *    в классах `kchs-chart-tip*` дизайн-системы, цвет маркера — атрибутом fill SVG.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export interface TipRow {
  /** Цвет маркера; нет — строка без маркера (итог, доля). */
  color?: string
  /** Пунктирный маркер — серия сравнения. */
  dashed?: boolean
  name: string
  value: string
}

function marker(color: string, dashed: boolean): string {
  const fill = escapeHtml(color)
  const shape = dashed
    ? `<rect x="0.5" y="4" width="9" height="2" rx="1" fill="${fill}"/>`
    : `<rect width="10" height="10" rx="2" fill="${fill}"/>`
  return `<svg class="kchs-chart-tip__marker" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">${shape}</svg>`
}

/** Тултип: заголовок (категория или период) и строки «значение — серия». */
export function tipHtml(title: string | null, rows: readonly TipRow[]): string {
  const head = title ? `<div class="kchs-chart-tip__title">${escapeHtml(title)}</div>` : ''
  const body = rows
    .map(
      (row) =>
        `<div class="kchs-chart-tip__row">${
          row.color
            ? marker(row.color, row.dashed ?? false)
            : '<span class="kchs-chart-tip__spacer"></span>'
        }<span class="kchs-chart-tip__value">${escapeHtml(row.value)}</span><span class="kchs-chart-tip__name">${escapeHtml(row.name)}</span></div>`,
    )
    .join('')
  return `<div class="kchs-chart-tip">${head}${body}</div>`
}

/** Общая часть тултипа: поверхность overlay, рамка, тень, без стрелки. */
export function tooltipBase(ctx: Ctx, trigger: 'item' | 'axis'): TooltipComponentOption {
  const { theme } = ctx
  return {
    trigger,
    confine: true,
    renderMode: 'html',
    className: 'kchs-chart-tooltip',
    backgroundColor: theme.overlay,
    borderColor: theme.grid,
    borderWidth: 1,
    padding: [8, 10],
    transitionDuration: ctx.animation ? 0.15 : 0,
    textStyle: { color: theme.text, fontFamily: theme.fontFamily, fontSize: 12 },
    // Рамку ECharts красит цветом серии — возвращаем цвет разделителя (идёт после)
    extraCssText: `border-color:${theme.grid};border-radius:8px;box-shadow:${theme.shadow};`,
    ...(trigger === 'axis'
      ? {
          axisPointer: {
            type: 'line',
            lineStyle: { color: theme.axis, width: 1, type: 'solid' },
            label: { show: false },
          },
        }
      : {}),
  }
}
