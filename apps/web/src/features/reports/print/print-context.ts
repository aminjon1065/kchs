import type { Locale, QueryResult, ReportParams, ReportPrintBlock } from '@kchs/contracts'
import { formatValue } from '@kchs/fields'
import { createContext, useContext, useEffect, useRef } from 'react'

/** Страница печати: параметры отчёта и куда блок сообщает свою готовность. */
export interface PrintContextValue {
  params: ReportParams
  timezone: string
  locale: Locale
  canSql: boolean
  /** Блок дорисован: его часть модели документа для DOCX (ADR-0078). */
  report: (blockId: string, model: ReportPrintBlock[]) => void
}

const PrintContext = createContext<PrintContextValue | null>(null)

export const PrintProvider = PrintContext.Provider

export function usePrint(): PrintContextValue {
  const value = useContext(PrintContext)
  // i18n-ignore — ошибка разработчика: блок печати вне страницы печати
  if (!value) throw new Error('usePrint: нет PrintProvider')
  return value
}

/**
 * Сообщить готовность блока, когда модель посчитана; повторно — только если она
 * изменилась (перезапрос данных не должен сбивать уже готовую страницу).
 */
export function useReportReady(blockId: string, model: ReportPrintBlock[] | null): void {
  const { report } = usePrint()
  const sent = useRef<string | null>(null)
  useEffect(() => {
    if (!model) return
    const key = JSON.stringify(model)
    if (sent.current === key) return
    sent.current = key
    report(blockId, model)
  }, [blockId, model, report])
}

export interface PrintTable {
  columns: Array<{ key: string; label: string; numeric: boolean }>
  rows: string[][]
  total: number
}

const NUMERIC = new Set(['integer', 'number', 'decimal', 'money', 'percent', 'rollup', 'duration'])
/** Столбцы, которые в таблице отчёта не читаются: геометрия — на карте, JSON — в данных. */
const SKIPPED = new Set(['geometry', 'json'])

/** Результат запроса → таблица печати: значения отформатированы по типам полей. */
export function printTable(
  result: QueryResult,
  options: { locale: Locale; timezone: string; maxRows: number },
): PrintTable {
  const shown = result.fields
    .map((field, index) => ({ field, index }))
    .filter(({ field }) => !SKIPPED.has(field.type))
  const columns = shown.map(({ field }) => ({
    key: field.name,
    label: field.label?.[options.locale] ?? field.label?.ru ?? field.name,
    numeric: NUMERIC.has(field.type),
  }))
  const rows = result.rows
    .slice(0, options.maxRows)
    .map((row) =>
      shown.map(({ field, index }) =>
        formatValue(
          row[index],
          { type: field.type, format: field.format ?? undefined },
          { locale: options.locale, timezone: options.timezone },
        ),
      ),
    )
  return { columns, rows, total: Math.max(result.rowCount ?? 0, result.rows.length) }
}
