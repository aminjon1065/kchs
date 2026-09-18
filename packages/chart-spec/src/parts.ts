import type { Channel, YChannel } from '@kchs/contracts'
import type { EChartsOption } from 'echarts'
import {
  baseOption,
  colorAssigner,
  legendOption,
  MAX_SERIES,
  OTHER_KEY,
  tokenColor,
} from './base.js'
import type { Built } from './cartesian.js'
import { categoryLabel, type MeasureFormat, measureFormat, shareFormat } from './format.js'
import type { ChartFilter, ChartTableModel, Ctx, FieldRef } from './model.js'
import { textOn } from './theme.js'
import { type TipRow, tipHtml, tooltipBase } from './tooltip.js'
import { compareValues } from './transform.js'
import { toNumber } from './values.js'

/** Доля целого: категория и сумма показателя. */
export interface Part {
  key: string
  raw: unknown
  label: string
  value: number
  /** «Прочее»: значения, сложенные в долю. */
  folded?: unknown[]
}

interface Parts {
  dim: Channel
  dimRef: FieldRef
  y: YChannel
  format: MeasureFormat
  parts: Part[]
  total: number
}

function keyOf(value: unknown): string {
  return value === null || value === undefined ? '' : String(value)
}

/**
 * Категории и суммы для долей целого. Измерение — ось X, без неё — поле цвета.
 * Неположительные значения доли не имеют — отбрасываются с пометкой.
 * `cap` — предел долей: сверх него остаток складывается в «Прочее».
 */
export function collectParts(
  ctx: Ctx,
  mode: { cap: number | null; order: 'value' | 'data'; foldAlways: boolean },
): Parts {
  const { spec, t } = ctx
  const colorCh = spec.encoding.color && 'field' in spec.encoding.color ? spec.encoding.color : null
  const dim = (spec.encoding.x ?? colorCh) as Channel
  const dimRef = ctx.field(dim.field) as FieldRef
  const y = spec.encoding.y[0] as YChannel
  const yRef = ctx.field(y.field) as FieldRef
  const sums = new Map<string, Part>()
  let dropped = 0
  for (const row of ctx.result.rows) {
    const raw = row[dimRef.index]
    const value = toNumber(row[yRef.index])
    if (value === null) continue
    const key = keyOf(raw)
    const part = sums.get(key)
    if (part) part.value += value
    else sums.set(key, { key, raw, label: categoryLabel(ctx, raw, dimRef.def), value })
  }
  let parts = [...sums.values()].filter((p) => {
    if (p.value > 0) return true
    dropped += 1
    return false
  })
  if (dropped > 0) ctx.notes.push(t('ui.chart.notes.nonPositive', { count: dropped }))

  const sort = spec.options.sort
  if (sort && sort.by === dim.field) {
    parts.sort((a, b) => compareValues(a.raw, b.raw, ctx.locale))
    if (sort.dir === 'desc') parts.reverse()
  } else if ((sort && sort.by === y.field) || mode.order === 'value') {
    parts.sort((a, b) => a.value - b.value)
    if (!sort || sort.dir === 'desc') parts.reverse()
  }

  const limit = Math.min(
    spec.options.limit ?? Number.POSITIVE_INFINITY,
    mode.cap ?? Number.POSITIVE_INFINITY,
  )
  if (parts.length > limit) {
    const fold = mode.foldAlways || spec.options.other
    const keep = fold ? Math.max(1, limit - 1) : limit
    const folded = parts.slice(keep)
    parts = parts.slice(0, keep)
    if (fold) {
      parts.push({
        key: OTHER_KEY,
        raw: null,
        label: t('ui.chart.other'),
        value: folded.reduce((sum, p) => sum + p.value, 0),
        folded: folded.map((p) => p.raw),
      })
    } else {
      ctx.notes.push(t('ui.chart.notes.limited', { shown: keep, total: keep + folded.length }))
    }
  }
  const total = parts.reduce((sum, p) => sum + p.value, 0)
  return { dim, dimRef, y, format: measureFormat(ctx, yRef.def, y.format), parts, total }
}

function partsTable(ctx: Ctx, data: Parts): ChartTableModel {
  const rows = data.parts.map((p) => [
    p.label,
    data.format.full(p.value),
    data.total > 0 ? shareFormat(ctx, p.value / data.total) : '',
  ])
  return {
    caption: '',
    columns: [
      { key: data.dim.field, label: ctx.label(data.dim), numeric: false },
      { key: data.y.field, label: ctx.label(data.y), numeric: true },
      { key: 'share', label: ctx.t('ui.chart.share'), numeric: true },
    ],
    rows,
    total: rows.length,
  }
}

function partFilter(data: Parts, part: Part | undefined): ChartFilter | null {
  if (!part) return null
  if (part.key === OTHER_KEY) {
    return {
      field: data.dim.field,
      op: 'not_in',
      value: data.parts.filter((p) => p.key !== OTHER_KEY).map((p) => p.raw),
    }
  }
  return { field: data.dim.field, op: 'eq', value: part.raw }
}

function partsEvents(data: Parts): Pick<Built, 'pick' | 'brush'> {
  return {
    pick: (params) => {
      const part = params.dataIndex === undefined ? undefined : data.parts[params.dataIndex]
      const filter = partFilter(data, part)
      return part && filter ? { label: part.label, filters: [filter] } : null
    },
    brush: () => null,
  }
}

function partTip(ctx: Ctx, data: Parts, colors: (p: Part) => string) {
  return {
    ...tooltipBase(ctx, 'item'),
    formatter: (params: { dataIndex: number }) => {
      const part = data.parts[params.dataIndex]
      if (!part) return ''
      const rows: TipRow[] = [
        { color: colors(part), name: ctx.label(data.y), value: data.format.full(part.value) },
      ]
      if (data.total > 0) {
        rows.push({
          name: ctx.t('ui.chart.share'),
          value: shareFormat(ctx, part.value / data.total),
        })
      }
      return tipHtml(part.label, rows)
    },
  }
}

// ─── Круговая и кольцевая ────────────────────────────────────────────────────

export function buildPie(ctx: Ctx, donut: boolean): Built {
  const { theme, spec } = ctx
  // Круговая — не больше 8 долей (contracts/chart-spec.md): остаток всегда в «Прочее»
  const data = collectParts(ctx, { cap: MAX_SERIES, order: 'value', foldAlways: true })
  const assign = colorAssigner(
    ctx,
    data.parts.map((p) => p.key),
  )
  const color = (p: Part) => (p.key === OTHER_KEY ? theme.other : assign(p.key))
  const labelsMode = spec.options.labels.show
  const showLabels = labelsMode === 'always' || (labelsMode === 'auto' && data.parts.length <= 6)
  const legendPosition = spec.options.legend.position
  const legend = legendOption(ctx, data.parts.length >= 2)
  const centerX =
    legend && legendPosition === 'right'
      ? '40%'
      : legend && legendPosition === 'left'
        ? '60%'
        : '50%'
  const centerY =
    legend && legendPosition === 'bottom'
      ? '46%'
      : legend && legendPosition === 'top'
        ? '54%'
        : '50%'
  const centerTotal =
    donut && legend !== undefined && (legendPosition === 'bottom' || legendPosition === 'top')
  const option = {
    ...baseOption(ctx),
    tooltip: partTip(ctx, data, color),
    ...(legend ? { legend } : {}),
    ...(donut && (centerTotal || !legend)
      ? {
          title: {
            text: data.format.full(data.total),
            subtext: ctx.label(data.y),
            left: 'center',
            top: centerY === '50%' ? 'middle' : centerY === '46%' ? '38%' : '46%',
            itemGap: 2,
            textStyle: {
              color: theme.text,
              fontSize: 20,
              fontWeight: 600,
              fontFamily: theme.fontFamily,
            },
            subtextStyle: {
              color: theme.textSecondary,
              fontSize: 12,
              fontFamily: theme.fontFamily,
            },
          },
        }
      : {}),
    series: [
      {
        type: 'pie',
        radius: donut ? ['50%', '72%'] : [0, '72%'],
        center: [centerX, centerY],
        startAngle: 90,
        avoidLabelOverlap: true,
        minAngle: 2,
        itemStyle: { borderColor: theme.surface, borderWidth: 2, borderRadius: donut ? 4 : 2 },
        label: showLabels
          ? {
              show: true,
              color: theme.textSecondary,
              fontSize: 11,
              formatter: (p: { dataIndex: number }) => {
                const part = data.parts[p.dataIndex]
                return part
                  ? `${part.label.replace(/[{}|]/g, '')}\n${shareFormat(ctx, part.value / data.total)}`
                  : ''
              },
            }
          : { show: false },
        labelLine: { show: showLabels, length: 8, length2: 8, lineStyle: { color: theme.axis } },
        emphasis: { scale: true, scaleSize: 4, focus: 'self' },
        data: data.parts.map((p) => ({
          name: p.label,
          value: p.value,
          itemStyle: { color: color(p) },
        })),
      },
    ],
  } as unknown as EChartsOption
  return { option, table: partsTable(ctx, data), ...partsEvents(data) }
}

// ─── Воронка ─────────────────────────────────────────────────────────────────

export function buildFunnel(ctx: Ctx): Built {
  const { theme, spec } = ctx
  // Этапы идут в порядке данных; один оттенок — этапы различаются подписями
  const data = collectParts(ctx, { cap: null, order: 'data', foldAlways: false })
  const fixed =
    spec.encoding.color && 'value' in spec.encoding.color ? spec.encoding.color.value : undefined
  const fill =
    tokenColor(ctx, data.y.color) ?? tokenColor(ctx, fixed) ?? (theme.categorical[0] as string)
  const first = data.parts[0]?.value ?? 0
  const option = {
    ...baseOption(ctx),
    tooltip: partTip(ctx, data, () => fill),
    series: [
      {
        type: 'funnel',
        sort: 'none',
        left: 8,
        top: 8,
        bottom: 8,
        width: '58%',
        gap: 2,
        minSize: '8%',
        maxSize: '100%',
        funnelAlign: 'center',
        itemStyle: { color: fill, borderColor: theme.surface, borderWidth: 0, borderRadius: 4 },
        label: {
          show: true,
          position: 'right',
          color: theme.textSecondary,
          fontSize: 12,
          formatter: (p: { dataIndex: number }) => {
            const part = data.parts[p.dataIndex]
            if (!part) return ''
            const conversion =
              first > 0 && p.dataIndex > 0 ? ` · ${shareFormat(ctx, part.value / first)}` : ''
            return `${part.label.replace(/[{}|]/g, '')}: ${data.format.full(part.value)}${conversion}`
          },
        },
        labelLine: { show: true, length: 12, lineStyle: { color: theme.axis, width: 1 } },
        emphasis: { focus: 'self', label: { fontWeight: 600 } },
        data: data.parts.map((p) => ({ name: p.label, value: p.value })),
      },
    ],
  } as unknown as EChartsOption
  return { option, table: partsTable(ctx, data), ...partsEvents(data) }
}

// ─── Древовидная карта ───────────────────────────────────────────────────────

interface TreeNode {
  name: string
  value: number
  raw: unknown
  itemStyle?: { color: string }
  label?: { color: string }
  upperLabel?: { color: string }
  children?: TreeNode[]
}

/**
 * Прямоугольники по площади. Поле цвета (номинальное) — группы верхнего уровня,
 * каждая своим оттенком (не больше 8, остаток — «Прочее»); без групп — один оттенок.
 */
export function buildTreemap(ctx: Ctx): Built {
  const { theme, spec, t } = ctx
  const colorCh = spec.encoding.color && 'field' in spec.encoding.color ? spec.encoding.color : null
  const grouped = Boolean(spec.encoding.x && colorCh && colorCh.field !== spec.encoding.x.field)
  const data = collectParts(ctx, { cap: ctx.maxPoints, order: 'value', foldAlways: false })
  const fixed =
    spec.encoding.color && 'value' in spec.encoding.color ? spec.encoding.color.value : undefined
  const single =
    tokenColor(ctx, data.y.color) ?? tokenColor(ctx, fixed) ?? (theme.categorical[0] as string)
  const nodes: TreeNode[] = []

  if (grouped && colorCh) {
    const groupRef = ctx.field(colorCh.field) as FieldRef
    const yRef = ctx.field(data.y.field) as FieldRef
    const groups = new Map<string, { raw: unknown; total: number; leaves: Map<string, TreeNode> }>()
    for (const row of ctx.result.rows) {
      const value = toNumber(row[yRef.index])
      if (value === null || value <= 0) continue
      const gRaw = row[groupRef.index]
      const gKey = keyOf(gRaw)
      let group = groups.get(gKey)
      if (!group) {
        group = { raw: gRaw, total: 0, leaves: new Map() }
        groups.set(gKey, group)
      }
      group.total += value
      const lRaw = row[data.dimRef.index]
      const lKey = keyOf(lRaw)
      const leaf = group.leaves.get(lKey)
      if (leaf) leaf.value += value
      else
        group.leaves.set(lKey, {
          name: categoryLabel(ctx, lRaw, data.dimRef.def),
          value,
          raw: lRaw,
        })
    }
    let keys = [...groups.keys()].sort(
      (a, b) => (groups.get(b)?.total ?? 0) - (groups.get(a)?.total ?? 0),
    )
    let folded: string[] = []
    if (keys.length > MAX_SERIES) {
      folded = keys.slice(MAX_SERIES - 1)
      keys = keys.slice(0, MAX_SERIES - 1)
    }
    const assign = colorAssigner(ctx, keys)
    for (const key of keys) {
      const group = groups.get(key)
      if (!group) continue
      const fill = assign(key)
      const ink = textOn(fill, theme)
      nodes.push({
        name: categoryLabel(ctx, group.raw, groupRef.def),
        value: group.total,
        raw: group.raw,
        itemStyle: { color: fill },
        label: { color: ink },
        upperLabel: { color: ink },
        children: [...group.leaves.values()].map((leaf) => ({ ...leaf, label: { color: ink } })),
      })
    }
    if (folded.length > 0) {
      const ink = textOn(theme.other, theme)
      nodes.push({
        name: t('ui.chart.other'),
        value: folded.reduce((sum, k) => sum + (groups.get(k)?.total ?? 0), 0),
        raw: null,
        itemStyle: { color: theme.other },
        label: { color: ink },
        upperLabel: { color: ink },
      })
    }
  } else {
    const ink = textOn(single, theme)
    for (const part of data.parts) {
      nodes.push({
        name: part.label,
        value: part.value,
        raw: part.raw,
        itemStyle: { color: part.key === OTHER_KEY ? theme.other : single },
        label: { color: part.key === OTHER_KEY ? textOn(theme.other, theme) : ink },
      })
    }
  }

  const option = {
    ...baseOption(ctx),
    tooltip: {
      ...tooltipBase(ctx, 'item'),
      formatter: (params: { data?: TreeNode; treePathInfo?: { name: string }[] }) => {
        const node = params.data
        if (!node) return ''
        const path = (params.treePathInfo ?? [])
          .slice(1)
          .map((p) => p.name)
          .join(' / ')
        const rows: TipRow[] = [
          {
            color: node.itemStyle?.color ?? single,
            name: ctx.label(data.y),
            value: data.format.full(node.value),
          },
        ]
        if (data.total > 0) {
          rows.push({ name: t('ui.chart.share'), value: shareFormat(ctx, node.value / data.total) })
        }
        return tipHtml(path || node.name, rows)
      },
    },
    series: [
      {
        type: 'treemap',
        left: 0,
        right: 0,
        top: 0,
        bottom: 0,
        roam: false,
        nodeClick: false,
        breadcrumb: { show: false },
        animation: ctx.animation,
        itemStyle: { borderColor: theme.surface, borderWidth: 2, gapWidth: 2, borderRadius: 4 },
        label: {
          show: true,
          fontSize: 12,
          overflow: 'truncate',
          formatter: (p: { data?: TreeNode }) =>
            p.data ? `${p.data.name.replace(/[{}|]/g, '')}\n${data.format.full(p.data.value)}` : '',
        },
        ...(grouped
          ? {
              levels: [
                {
                  itemStyle: { borderColor: theme.surface, borderWidth: 0, gapWidth: 2 },
                  upperLabel: { show: false },
                },
                {
                  itemStyle: { borderColor: theme.surface, borderWidth: 2, gapWidth: 1 },
                  upperLabel: { show: true, height: 22, fontSize: 12, fontWeight: 600 },
                },
              ],
            }
          : {}),
        data: nodes,
      },
    ],
  } as unknown as EChartsOption

  return {
    option,
    table: partsTable(ctx, data),
    pick: (params) => {
      const node = params.data as TreeNode | undefined
      if (!node) return null
      if (node.raw === null) return null
      const groupField = colorCh?.field
      const isGroup = grouped && node.children !== undefined
      const filters: ChartFilter[] = [
        { field: isGroup && groupField ? groupField : data.dim.field, op: 'eq', value: node.raw },
      ]
      return { label: node.name, filters }
    },
    brush: () => null,
  }
}
