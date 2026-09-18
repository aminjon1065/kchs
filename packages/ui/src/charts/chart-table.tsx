import type { ChartTableModel } from '@kchs/chart-spec'
import { useUiT } from '../i18n/ui-locale.js'
import { cn } from '../lib/cn.js'

export interface ChartTableProps {
  model: ChartTableModel
  id?: string
  className?: string
  /** Высота области прокрутки, px. */
  maxHeight?: number
}

/**
 * Таблица данных графика и тип графика «таблица». Значения уже отформатированы
 * компилятором; первый столбец — заголовок строки, числа — вправо табличными
 * цифрами. Это же — доступная замена графика для экранных дикторов и для
 * цветов палитры с контрастом ниже 3:1 (ADR-0049).
 */
export function ChartTable({ model, id, className, maxHeight = 320 }: ChartTableProps) {
  const t = useUiT()
  const truncated = model.total > model.rows.length
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      {/* Область прокрутки доступна с клавиатуры: фокус и подпись */}
      <section
        id={id}
        aria-label={model.caption || t('ui.chart.dataTable')}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: прокручиваемая область должна получать фокус (axe scrollable-region-focusable)
        tabIndex={0}
        className="overflow-auto rounded-md border border-line bg-surface"
        style={{ maxHeight }}
      >
        <table className="w-full border-collapse text-sm">
          {model.caption ? <caption className="sr-only">{model.caption}</caption> : null}
          <thead className="sticky top-0 z-[1] bg-surface-2">
            <tr>
              {model.columns.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  className={cn(
                    'h-[var(--row-h)] border-b border-line px-3 text-xs font-medium whitespace-nowrap text-fg-secondary',
                    column.numeric ? 'text-right' : 'text-left',
                  )}
                >
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {model.rows.map((row, rowIndex) => (
              // Строки таблицы данных без идентификаторов и неизменяемы — индекс устойчив
              <tr key={rowIndex} className="border-b border-line last:border-b-0">
                {row.map((cell, cellIndex) => {
                  const column = model.columns[cellIndex]
                  const align = column?.numeric ? 'tabular text-right' : 'text-left'
                  return cellIndex === 0 ? (
                    <th
                      key={column?.key ?? cellIndex}
                      scope="row"
                      className={cn('h-[var(--row-h)] px-3 font-normal text-fg', align)}
                    >
                      {cell}
                    </th>
                  ) : (
                    <td
                      key={column?.key ?? cellIndex}
                      className={cn('h-[var(--row-h)] px-3 whitespace-nowrap text-fg', align)}
                    >
                      {cell}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      {truncated ? (
        <p className="text-xs text-fg-muted">
          {t('ui.chart.tableTruncated', { shown: model.rows.length, total: model.total })}
        </p>
      ) : null}
    </div>
  )
}
