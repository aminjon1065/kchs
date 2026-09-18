import { Columns3 } from 'lucide-react'
import { useUiT } from '../../i18n/ui-locale.js'
import { Button } from '../../primitives/button.js'
import { Checkbox } from '../../primitives/controls.js'
import { Popover, PopoverContent, PopoverTrigger } from '../../primitives/overlays.js'
import type { DataGridColumn, DataGridColumnState } from './types.js'

export interface DataGridColumnsButtonProps {
  columns: DataGridColumn[]
  state: DataGridColumnState
  onChange: (state: DataGridColumnState) => void
  className?: string
}

/**
 * Кнопка «Столбцы» для панели над DataGrid: какие столбцы показывать.
 * Раскладку хранит родитель (`useDataGridColumnState`) и передаёт её и сюда,
 * и в таблицу. Последний видимый столбец скрыть нельзя.
 */
export function DataGridColumnsButton({
  columns,
  state,
  onChange,
  className,
}: DataGridColumnsButtonProps) {
  const t = useUiT()
  const byKey = new Map(columns.map((column) => [column.key, column]))
  const hidden = new Set(state.hidden)
  const visibleCount = columns.filter((column) => !hidden.has(column.key)).length
  const ordered = [
    ...state.pinned,
    ...state.order.filter((key) => !state.pinned.includes(key)),
  ].flatMap((key) => byKey.get(key) ?? [])

  const setVisible = (key: string, visible: boolean) =>
    onChange({
      ...state,
      hidden: visible ? state.hidden.filter((item) => item !== key) : [...state.hidden, key],
    })

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="sm" icon={<Columns3 className="size-3.5" />} className={className}>
          {t('ui.grid.columns')}
          {hidden.size > 0 ? (
            <span className="tabular text-fg-muted">
              {visibleCount}/{columns.length}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-0">
        <div className="border-b border-line px-3 py-2 text-xs font-medium text-fg-secondary">
          {t('ui.grid.columnsTitle')}
        </div>
        <div className="flex max-h-80 flex-col gap-0.5 overflow-auto p-1.5">
          {ordered.map((column) => {
            const visible = !hidden.has(column.key)
            return (
              <div key={column.key} className="rounded-xs px-1.5 py-1 hover:bg-surface-3">
                <Checkbox
                  label={column.label}
                  checked={visible}
                  disabled={visible && visibleCount === 1}
                  onCheckedChange={(checked) => setVisible(column.key, checked === true)}
                />
              </div>
            )
          })}
        </div>
        <div className="flex justify-end border-t border-line p-1.5">
          <Button
            size="sm"
            variant="ghost"
            disabled={hidden.size === 0}
            onClick={() => onChange({ ...state, hidden: [] })}
          >
            {t('ui.grid.showAll')}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
