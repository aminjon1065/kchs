import { formatNumber } from '@kchs/fields'
import { Loader2, Plus } from 'lucide-react'
import { useUiT } from '../../i18n/ui-locale.js'
import { cn } from '../../lib/cn.js'
import type { SelectionSummary } from './summary.js'
import type { ValueContext } from './values.js'

/** Сообщение подвала: итог сохранения, вставки, копирования или причина отказа. */
export interface GridStatus {
  tone: 'info' | 'danger'
  text: string
}

/**
 * Подвал таблицы данных: ход сохранения или сообщение, выделенные строки, сводка по
 * выделенным ячейкам, «Добавить строки» и счётчик строк.
 */
export function GridFooter({
  pending,
  message,
  selectedRowCount,
  summary,
  appendArmed,
  onToggleAppend,
  loading,
  rowCount,
  totalCount,
  rowCountApprox,
  ctx,
}: {
  pending: number
  message: GridStatus | null
  /** Выделены строки целиком — сколько; иначе null. */
  selectedRowCount: number | null
  summary: SelectionSummary | null
  appendArmed: boolean
  /** Есть, когда таблица правится и умеет добавлять строки. */
  onToggleAppend?: () => void
  loading: boolean
  rowCount: number
  totalCount?: number
  rowCountApprox: boolean
  ctx: ValueContext
}) {
  const t = useUiT()
  const counter =
    totalCount !== undefined && totalCount !== rowCount
      ? t('ui.grid.rowsOf', { shown: formatNumber(rowCount, {}, ctx), count: totalCount })
      : rowCountApprox
        ? t('ui.grid.rowsApprox', { count: rowCount })
        : t('ui.grid.rows', { count: rowCount })

  return (
    <div className="flex h-8 shrink-0 items-center gap-3 border-t border-line bg-surface px-3 text-xs text-fg-secondary">
      <div
        role="status"
        className={cn(
          'flex min-w-0 flex-1 items-center gap-1.5',
          pending === 0 && message?.tone === 'danger' && 'text-danger',
        )}
      >
        {pending > 0 ? (
          <>
            <Loader2 aria-hidden className="size-3.5 shrink-0 animate-spin-fast" />
            <span className="truncate">{t('ui.grid.saving')}</span>
          </>
        ) : (
          <span className="truncate">{message?.text}</span>
        )}
      </div>
      {selectedRowCount !== null ? (
        <div className="shrink-0 tabular">
          {t('ui.grid.selectedRows', { count: selectedRowCount })}
        </div>
      ) : null}
      {summary ? (
        <div className="flex shrink-0 items-center gap-3 tabular">
          <span>{t('ui.grid.selected', { count: formatNumber(summary.cells, {}, ctx) })}</span>
          {summary.sum !== null ? (
            <span>{t('ui.grid.sum', { value: formatNumber(summary.sum, {}, ctx) })}</span>
          ) : null}
          {summary.avg !== null ? (
            <span>{t('ui.grid.avg', { value: formatNumber(summary.avg, {}, ctx) })}</span>
          ) : null}
          {summary.partial ? <span className="text-fg-muted">{t('ui.grid.partial')}</span> : null}
        </div>
      ) : null}
      {onToggleAppend ? (
        <button
          type="button"
          aria-pressed={appendArmed}
          onClick={onToggleAppend}
          className={cn(
            'flex h-6 shrink-0 items-center gap-1 rounded-xs px-1.5 hover:bg-surface-3 hover:text-fg',
            appendArmed && 'bg-accent-subtle text-accent',
          )}
        >
          <Plus aria-hidden className="size-3.5" />
          {t('ui.grid.appendRows')}
        </button>
      ) : null}
      <div className="flex shrink-0 items-center gap-1.5 text-fg-muted tabular">
        {loading && rowCount > 0 ? (
          <Loader2 aria-hidden className="size-3.5 animate-spin-fast" />
        ) : null}
        {loading && rowCount === 0 ? null : counter}
      </div>
    </div>
  )
}
