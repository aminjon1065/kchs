import {
  type ChartData,
  type ChartEncoding,
  ChartSpec,
  type ChartType,
  type QueryResult,
  type QueryResultField,
} from '@kchs/contracts'
import { isNumericField } from './table.js'

type Role = 'time' | 'measure' | 'dimension' | 'skip'

interface FieldInfo {
  field: QueryResultField
  role: Role
  distinct: number
  /** Средняя длина подписи — длинные подписи кладут столбцы горизонтально. */
  avgLength: number
}

/** Роль поля в графике — по семантике, затем по типу. */
function roleOf(field: QueryResultField): Role {
  switch (field.semantic) {
    case 'time':
      return 'time'
    case 'measure':
      return 'measure'
    case 'identifier':
    case 'geometry':
    case 'text':
    case 'system':
      return 'skip'
    case 'dimension':
    case 'category':
    case 'territory':
    case 'lookup':
      return field.type === 'date' || field.type === 'datetime' ? 'time' : 'dimension'
    default:
      break
  }
  if (field.type === 'date' || field.type === 'datetime') return 'time'
  if (isNumericField(field)) return 'measure'
  if (['geometry', 'json', 'file', 'signature', 'long_text', 'identifier'].includes(field.type)) {
    return 'skip'
  }
  return 'dimension'
}

function profile(result: QueryResult): FieldInfo[] {
  return result.fields.map((field, index) => {
    const values = new Set<string>()
    let length = 0
    for (const row of result.rows) {
      const text = String(row[index] ?? '')
      values.add(text)
      length += text.length
    }
    return {
      field,
      role: roleOf(field),
      distinct: values.size,
      avgLength: result.rows.length ? length / result.rows.length : 0,
    }
  })
}

const channel = (info: FieldInfo, type: 'temporal' | 'quantitative' | 'nominal' | 'ordinal') => ({
  field: info.field.name,
  type,
})
const dimensionChannel = (info: FieldInfo) =>
  channel(
    info,
    info.role === 'time' ? 'temporal' : isNumericField(info.field) ? 'ordinal' : 'nominal',
  )

/**
 * Умные значения по умолчанию (P1-E06 S04): тип и кодировка по семантике полей
 * результата. Одна строка и показатель — «показатель»; время — линия (с цветом по
 * измерению до 8 значений); измерение и показатель — столбцы по убыванию; два
 * измерения — стопка или тепловая карта; два показателя — точечная. Никогда не
 * предлагает две оси. `type` — подобрать кодировку под выбранный пользователем тип.
 */
export function suggestChart(
  result: QueryResult,
  data: ChartData,
  options: { type?: ChartType } = {},
): ChartSpec {
  const infos = profile(result)
  const measures = infos.filter((i) => i.role === 'measure')
  const times = infos.filter((i) => i.role === 'time')
  const dims = infos.filter((i) => i.role === 'dimension')
  const rows = result.rows.length
  const m0 = measures[0]
  const m1 = measures[1]
  const time = times[0]
  const dim = [...dims].sort((a, b) => a.distinct - b.distinct)[0]
  const dim2 = dims.find((d) => d !== dim)
  const y = (list: FieldInfo[]) =>
    list.map((m) => ({ ...channel(m, 'quantitative'), axis: 'left' as const }))

  let type: ChartType = 'table'
  let encoding: Partial<ChartEncoding> = {}
  const options_: Record<string, unknown> = {}

  const byDimension = (d: FieldInfo, list: FieldInfo[]) => {
    encoding = { x: dimensionChannel(d), y: y(list) }
    if (d.role !== 'time' && !isNumericField(d.field)) {
      options_.sort = { by: (list[0] as FieldInfo).field.name, dir: 'desc' }
    }
    if (d.distinct > 12 || d.avgLength > 14) options_.horizontal = true
    if (d.distinct > 30) Object.assign(options_, { limit: 30, other: true })
  }

  const auto = (): void => {
    if (m0 && rows === 1 && !time && dims.length === 0) {
      type = 'number'
      encoding = { y: y([m0]) }
    } else if (time && m0) {
      type = 'line'
      if (dim && dim.distinct <= 8) {
        encoding = {
          x: channel(time, 'temporal'),
          y: y([m0]),
          color: { ...channel(dim, 'nominal'), palette: 'categorical' },
        }
      } else {
        encoding = { x: channel(time, 'temporal'), y: y(measures.slice(0, 3)) }
      }
    } else if (dim && dim2 && m0) {
      if (dim.distinct > 8 && dim2.distinct > 8) {
        type = 'heatmap'
        encoding = {
          x: dimensionChannel(dim2),
          y: [{ ...dimensionChannel(dim), axis: 'left' }],
          color: { ...channel(m0, 'quantitative'), palette: 'sequential' },
        }
      } else {
        type = 'bar'
        const [series, axis] = dim.distinct <= 8 ? [dim, dim2] : [dim2, dim]
        byDimension(axis, [m0])
        encoding.color = { ...channel(series, 'nominal'), palette: 'categorical' }
        options_.stacked = true
      }
    } else if (dim && m0) {
      type = 'bar'
      // Два показателя разного масштаба на одной оси нечитаемы — берём первый
      const scale = (m: FieldInfo) => {
        const index = result.fields.indexOf(m.field)
        return Math.max(...result.rows.map((r) => Math.abs(Number(r[index]) || 0)), 0)
      }
      const comparable =
        m1 && scale(m1) > 0 && scale(m0) / scale(m1) < 10 && scale(m1) / scale(m0) < 10
      byDimension(dim, comparable && m1 ? [m0, m1] : [m0])
    } else if (m0 && m1) {
      type = measures.length >= 3 ? 'bubble' : 'scatter'
      encoding = { x: channel(m0, 'quantitative'), y: y([m1]) }
      if (measures[2]) encoding.size = channel(measures[2], 'quantitative')
    } else if (m0 && rows > 20) {
      type = 'histogram'
      encoding = { x: channel(m0, 'quantitative') }
    } else if (m0) {
      type = 'number'
      encoding = { y: y([m0]) }
    }
  }

  const forType = (wanted: ChartType): void => {
    type = wanted
    const firstDim = dim ?? time
    switch (wanted) {
      case 'number':
      case 'gauge':
        encoding = m0 ? { y: y([m0]), ...(time ? { x: channel(time, 'temporal') } : {}) } : {}
        break
      case 'line':
      case 'area':
        if (time && m0) encoding = { x: channel(time, 'temporal'), y: y([m0]) }
        else if (firstDim && m0) encoding = { x: dimensionChannel(firstDim), y: y([m0]) }
        break
      case 'bar':
      case 'combo':
        if (firstDim && m0) {
          byDimension(firstDim, wanted === 'combo' && m1 ? [m0, m1] : [m0])
          if (wanted === 'combo' && encoding.y?.[1]) {
            encoding.y = [
              { ...(encoding.y[0] as NonNullable<ChartEncoding['y'][number]>), mark: 'bar' },
              { ...(encoding.y[1] as NonNullable<ChartEncoding['y'][number]>), mark: 'line' },
            ]
          }
        }
        break
      case 'pie':
      case 'donut':
      case 'funnel':
      case 'treemap':
        if (firstDim && m0) encoding = { x: dimensionChannel(firstDim), y: y([m0]) }
        break
      case 'scatter':
      case 'bubble':
        if (m0 && m1) {
          encoding = { x: channel(m0, 'quantitative'), y: y([m1]) }
          if (wanted === 'bubble' && measures[2])
            encoding.size = channel(measures[2], 'quantitative')
          if (dim && dim.distinct <= 3)
            encoding.color = { ...channel(dim, 'nominal'), palette: 'categorical' }
        }
        break
      case 'heatmap': {
        // Столбцы — время (если есть), строки — измерение
        const columns = time ?? dim
        const rowsInfo = columns === time ? dim : dim2
        if (columns && rowsInfo && m0) {
          encoding = {
            x: dimensionChannel(columns),
            y: [{ ...dimensionChannel(rowsInfo), axis: 'left' }],
            color: { ...channel(m0, 'quantitative'), palette: 'sequential' },
          }
        }
        break
      }
      case 'histogram':
        if (m0) encoding = { x: channel(m0, 'quantitative') }
        break
      default:
        encoding = {}
    }
  }

  if (options.type) forType(options.type)
  else auto()

  return ChartSpec.parse({ version: 1, type, data, encoding, options: options_ })
}
