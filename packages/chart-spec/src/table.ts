import type { QueryResultField } from '@kchs/contracts'
import { categoryLabel, measureFormat } from './format.js'
import type { ChartTableModel, Ctx } from './model.js'
import { langText } from './model.js'
import { toNumber } from './values.js'

/** Строк в таблице данных графика: больше — только выгрузкой. */
export const TABLE_ROWS = 1000

const NUMERIC = new Set(['integer', 'number', 'decimal', 'money', 'percent', 'duration', 'rollup'])

export function isNumericField(field: QueryResultField): boolean {
  return NUMERIC.has(field.type)
}

/**
 * Таблица как тип графика (и сводная — результат уже развёрнут сервером):
 * столбцы кодировки по порядку, без кодировки — все поля результата.
 */
export function buildTable(ctx: Ctx): ChartTableModel {
  const { encoding } = ctx.spec
  const named = [
    encoding.x?.field,
    ...encoding.y.map((y) => y.field),
    encoding.color && 'field' in encoding.color ? encoding.color.field : undefined,
    encoding.size?.field,
    encoding.text?.field,
    ...encoding.tooltip,
  ].filter((f): f is string => Boolean(f))
  const wanted = [...new Set(named)].filter((f) => ctx.field(f))
  const fields = wanted.length
    ? wanted.map((f) => ctx.field(f)).filter((f) => f !== null)
    : ctx.result.fields.map((def, index) => ({ index, def }))
  const channelOf = (name: string) =>
    encoding.x?.field === name ? encoding.x : (encoding.y.find((y) => y.field === name) ?? null)
  const columns = fields.map(({ def }) => ({
    key: def.name,
    label:
      langText(channelOf(def.name)?.label, ctx.locale) ??
      langText(def.label, ctx.locale) ??
      def.name,
    numeric: isNumericField(def),
  }))
  const formats = fields.map(({ def }) =>
    isNumericField(def) ? measureFormat(ctx, def, channelOf(def.name)?.format) : null,
  )
  const rows = ctx.result.rows.slice(0, TABLE_ROWS).map((row) =>
    fields.map(({ def, index }, i) => {
      const raw = row[index]
      const format = formats[i]
      if (format) {
        const n = toNumber(raw)
        return n === null ? '' : format.full(n)
      }
      return raw === null || raw === undefined ? '' : categoryLabel(ctx, raw, def)
    }),
  )
  return { caption: '', columns, rows, total: ctx.result.rowCount ?? ctx.result.rows.length }
}
