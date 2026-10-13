import type { Translator } from '@kchs/i18n'
import { useEffect, useRef, useState } from 'react'
import type { GridStatus } from './grid-footer.js'
import {
  type CellChange,
  dropChanges,
  type EditHistory,
  EMPTY_HISTORY,
  recordEdit,
} from './history.js'
import { useLatest, useStableCallback } from './hooks.js'
import {
  type CellOverlay,
  cellKey,
  type ErrorMap,
  type OverlayMap,
  settleOverlay,
  withoutCells,
} from './overlay.js'
import type { DataGridEditResult, DataGridProps } from './types.js'

const NO_OVERLAY: OverlayMap = new Map()
export const NO_ERRORS: ErrorMap = new Map()

export interface ApplyOptions {
  /** Сообщение в подвале после сохранения. */
  success?: GridStatus
  /** Отмена или повтор: история после применения и до него (для отката при отказе). */
  step?: { next: EditHistory; previous: EditHistory }
}

/**
 * Правки таблицы данных: несохранённые и сохраняемые значения поверх строк родителя
 * (оверлей), ошибки ячеек, история отмены, сообщение подвала и счётчик сохранений.
 * Изменения уходят пакетами в `onEdit`, новые строки — в `onAppendRows`.
 */
export function useGridEdits({
  getRow,
  onEdit,
  onAppendRows,
  t,
}: Pick<DataGridProps, 'getRow' | 'onEdit' | 'onAppendRows'> & { t: Translator }) {
  const [overlay, setOverlay] = useState<OverlayMap>(NO_OVERLAY)
  const [errors, setErrors] = useState<ErrorMap>(NO_ERRORS)
  const [history, setHistory] = useState<EditHistory>(EMPTY_HISTORY)
  const [status, setStatus] = useState<GridStatus | null>(null)
  const [pending, setPending] = useState(0)
  const overlayRef = useLatest(overlay)
  const historyRef = useLatest(history)

  // Новые данные от родителя: сохранённые правки, которые данные уже отражают, снимаются
  const lastGetRow = useRef(getRow)
  useEffect(() => {
    if (lastGetRow.current === getRow) return
    lastGetRow.current = getRow
    setOverlay((current) => settleOverlay(current, getRow))
  }, [getRow])

  /**
   * Пакет изменений: сразу виден в ячейках, уходит в `onEdit`; отказ сервера
   * (целиком или по ячейкам) откатывает ячейки и объясняет причину в подвале.
   */
  const applyChanges = useStableCallback(
    async (changes: CellChange[], options: ApplyOptions = {}) => {
      if (!onEdit || changes.length === 0) {
        if (options.success) setStatus(options.success)
        return
      }
      const token = {}
      setOverlay((current) => {
        const next = new Map<string, CellOverlay>(current)
        for (const change of changes) {
          next.set(cellKey(change.rowId, change.key), {
            rowId: change.rowId,
            rowIndex: change.rowIndex,
            key: change.key,
            value: change.value,
            token,
            status: 'pending',
            generation: 0,
          })
        }
        return next
      })
      setErrors((current) => withoutCells(current, changes))
      const step = options.step
      setHistory((current) => (step ? step.next : recordEdit(current, changes)))
      setPending((count) => count + 1)
      setStatus(null)

      let rejected: NonNullable<DataGridEditResult['rejected']> = []
      let failure: string | null = null
      try {
        rejected = (await onEdit(changes))?.rejected ?? []
      } catch (error) {
        failure = error instanceof Error ? error.message : ''
      }
      setPending((count) => count - 1)

      const reasons = new Map(rejected.map((item) => [cellKey(item.rowId, item.key), item.message]))
      const dropped = new Set(
        failure !== null
          ? changes
          : changes.filter((change) => reasons.has(cellKey(change.rowId, change.key))),
      )
      setOverlay((current) => {
        const next = new Map<string, CellOverlay>(current)
        for (const change of changes) {
          const key = cellKey(change.rowId, change.key)
          const entry = next.get(key)
          if (!entry || entry.token !== token) continue
          if (dropped.has(change)) next.delete(key)
          else next.set(key, { ...entry, status: 'saved' })
        }
        return next
      })
      if (dropped.size === 0) {
        if (options.success) setStatus(options.success)
        return
      }
      setErrors((current) => {
        const next = new Map(current)
        for (const change of dropped) {
          const key = cellKey(change.rowId, change.key)
          next.set(key, reasons.get(key) ?? failure ?? '')
        }
        return next
      })
      if (step) setHistory((current) => (current === step.next ? step.previous : current))
      else setHistory((current) => dropChanges(current, changes, dropped))
      const message = rejected[0]?.message || failure
      const reason = message ? t('ui.grid.saveFailed', { message }) : t('ui.grid.notSaved')
      // Отчёт о вставке остаётся рядом с причиной отказа
      const report = options.success?.text
      setStatus({ tone: 'danger', text: report ? `${reason} · ${report}` : reason })
    },
  )

  /** Новые строки — родителю одним пакетом; итог и причина отказа — в подвале. */
  const appendRows = async (rows: Array<Record<string, unknown>>, report: string | null) => {
    if (!onAppendRows) return
    setPending((count) => count + 1)
    let message: string | null = null
    try {
      const rejected = (await onAppendRows(rows))?.rejected ?? []
      if (rejected.length > 0) message = rejected[0]?.message ?? ''
    } catch (error) {
      message = error instanceof Error ? error.message : ''
    }
    setPending((count) => count - 1)
    const text =
      message === null
        ? t('ui.grid.appended', { count: rows.length })
        : t('ui.grid.appendFailed', { message })
    setStatus({
      tone: message === null ? 'info' : 'danger',
      text: report ? `${text} · ${report}` : text,
    })
  }

  return {
    overlay,
    overlayRef,
    errors,
    setErrors,
    historyRef,
    status,
    setStatus,
    pending,
    applyChanges,
    appendRows,
  }
}
