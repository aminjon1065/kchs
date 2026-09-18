import type { DatasetRecord, DatasetRow, DatasetRowsQuery, QueryResult } from '@kchs/contracts'
import {
  Button,
  Callout,
  DataGrid,
  type DataGridAppendResult,
  type DataGridCellChange,
  type DataGridColumn,
  DataGridColumnsButton,
  type DataGridEditResult,
  type DataGridRow,
  type DataGridSortItem,
  IconButton,
  SearchInput,
  useDataGridColumnState,
  useDebouncedValue,
} from '@kchs/ui'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { ApiError, http } from '~/shared/api/client.js'
import { meQuery } from '~/shared/api/queries.js'
import { ExportDialog } from './export-dialog.js'
import { dataKeys } from './queries.js'

/** Строк в странице таблицы: грид просит окна, страницы грузятся по мере прокрутки. */
const PAGE = 200

interface Loaded {
  rows: DataGridRow[]
  /** Версии строк для правки: `_ver` по `_id`. */
  versions: Map<string, number>
}

/** Страница ответа `rows/query` → строки грида и их версии. */
function toRows(result: QueryResult): Loaded {
  const idIndex = result.fields.findIndex((field) => field.name === '_id')
  const verIndex = result.fields.findIndex((field) => field.name === '_ver')
  const versions = new Map<string, number>()
  const rows = result.rows.map((row) => {
    const id = String(row[idIndex])
    versions.set(id, Number(row[verIndex]))
    const values: Record<string, unknown> = {}
    result.fields.forEach((field, index) => {
      if (field.name !== '_id' && field.name !== '_ver') values[field.name] = row[index]
    })
    return { id, values }
  })
  return { rows, versions }
}

/**
 * Вкладка «Таблица» экрана датасета (03-screens.md §5): DataGrid над страницами
 * `POST /datasets/{id}/rows/query` — сортировка и поиск на сервере, правка ячеек
 * с версией строки; конфликт возвращает ячейки и показывает текущие значения.
 */
export function DatasetTable({ dataset, canEdit }: { dataset: DatasetRecord; canEdit: boolean }) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const client = useQueryClient()
  const { data: me } = useQuery(meQuery())

  const [search, setSearch] = useState('')
  const debouncedSearch = useDebouncedValue(search.trim(), 300)
  const [sort, setSort] = useState<DataGridSortItem[]>([])
  const [pages, setPages] = useState<Map<number, DataGridRow[]>>(new Map())
  const [rowCount, setRowCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [failure, setFailure] = useState<string | null>(null)
  const versions = useRef(new Map<string, number>())
  const requested = useRef(new Set<number>())
  // Поколение запроса: ответы прежних сортировки и поиска отбрасываются
  const generation = useRef(0)
  const [reloads, setReloads] = useState(0)
  const [exporting, setExporting] = useState(false)
  const canExport = me?.capabilities.includes('data.export') ?? false

  const columns = useMemo<DataGridColumn[]>(
    () =>
      dataset.fields.map((field) => ({
        key: field.key,
        label: field.label[locale] ?? field.label.ru ?? field.key,
        type: field.type,
        ...(field.format ? { format: field.format } : {}),
        ...(field.options ? { options: field.options } : {}),
        editable: canEdit && dataset.settings.editable && !field.readOnly,
      })),
    [dataset.fields, dataset.settings.editable, canEdit, locale],
  )
  const [columnState, setColumnState] = useDataGridColumnState(columns)

  const load = useCallback(
    async (page: number, current: number) => {
      requested.current.add(page)
      const body: DatasetRowsQuery = {
        sort: sort.map((item) => ({ field: item.key, dir: item.dir })),
        ...(debouncedSearch ? { search: debouncedSearch } : {}),
        limit: PAGE,
        offset: page * PAGE,
        count: page === 0,
      }
      try {
        const result = await http.post<QueryResult>(`/datasets/${dataset.id}/rows/query`, body)
        if (current !== generation.current) return
        const loaded = toRows(result)
        for (const [id, ver] of loaded.versions) versions.current.set(id, ver)
        setPages((existing) => new Map(existing).set(page, loaded.rows))
        if (page === 0) setRowCount(result.rowCount ?? loaded.rows.length)
        setFailure(null)
      } catch (error) {
        requested.current.delete(page)
        if (current !== generation.current) return
        setFailure(error instanceof ApiError ? error.message : t('data.table.loadFailed'))
      } finally {
        if (page === 0 && current === generation.current) setLoading(false)
      }
    },
    [dataset.id, sort, debouncedSearch, t],
  )

  // Новые сортировка, поиск или «Обновить» — таблица читается заново с первой страницы
  // biome-ignore lint/correctness/useExhaustiveDependencies: reloads — намеренный повод перечитать
  useEffect(() => {
    generation.current += 1
    requested.current = new Set()
    versions.current = new Map()
    setPages(new Map())
    setLoading(true)
    void load(0, generation.current)
  }, [load, reloads])

  const getRow = useCallback(
    (index: number) => pages.get(Math.floor(index / PAGE))?.[index % PAGE],
    [pages],
  )

  const onVisibleRangeChange = useCallback(
    (start: number, end: number) => {
      const last = Math.floor(Math.max(end - 1, 0) / PAGE)
      for (let page = Math.floor(start / PAGE); page <= last; page++) {
        if (page * PAGE >= rowCount || requested.current.has(page)) continue
        void load(page, generation.current)
      }
    },
    [load, rowCount],
  )

  /** Заменить значения строки в загруженной странице (после правки или конфликта). */
  const replaceRow = useCallback((row: DatasetRow) => {
    versions.current.set(row._id, row._ver)
    setPages((existing) => {
      const next = new Map(existing)
      for (const [page, rows] of existing) {
        const index = rows.findIndex((item) => item.id === row._id)
        if (index === -1) continue
        const copy = [...rows]
        copy[index] = { id: row._id, values: { ...rows[index]?.values, ...row.values } }
        next.set(page, copy)
      }
      return next
    })
  }, [])

  const onEdit = useCallback(
    async (changes: DataGridCellChange[]): Promise<DataGridEditResult> => {
      const byRow = new Map<string, DataGridCellChange[]>()
      for (const change of changes)
        byRow.set(change.rowId, [...(byRow.get(change.rowId) ?? []), change])
      const rejected: NonNullable<DataGridEditResult['rejected']> = []
      for (const [rowId, rowChanges] of byRow) {
        const values = Object.fromEntries(rowChanges.map((change) => [change.key, change.value]))
        try {
          const row = await http.patch<DatasetRow>(`/datasets/${dataset.id}/rows/${rowId}`, {
            values,
            ver: versions.current.get(rowId) ?? 1,
          })
          replaceRow(row)
        } catch (error) {
          const problem = error instanceof ApiError ? error : null
          const current = problem?.problem.data?.current as DatasetRow | undefined
          if (current) replaceRow(current)
          const fieldErrors = problem?.fieldErrors() ?? {}
          for (const change of rowChanges) {
            rejected.push({
              rowId,
              key: change.key,
              message:
                fieldErrors[change.key] ??
                (problem?.status === 409
                  ? t('data.table.conflict')
                  : (problem?.message ?? t('errors.unknown'))),
            })
          }
        }
      }
      // Счётчик строк и версия в шапке изменились
      void client.invalidateQueries({ queryKey: dataKeys.dataset(dataset.id) })
      void client.invalidateQueries({ queryKey: dataKeys.versions(dataset.id) })
      return rejected.length > 0 ? { rejected } : {}
    },
    [client, dataset.id, replaceRow, t],
  )

  /** Вставка ниже последней строки — новые строки одним пакетом (до 1000, как у API). */
  const onAppendRows = useCallback(
    async (rows: Array<Record<string, unknown>>): Promise<DataGridAppendResult> => {
      try {
        await http.post(`/datasets/${dataset.id}/rows`, {
          rows: rows.map((values) => ({ values })),
        })
      } catch (error) {
        const index = error instanceof ApiError ? Number(error.problem.data?.row ?? 0) : 0
        const message = error instanceof ApiError ? error.message : t('errors.unknown')
        return { rejected: [{ index, message }] }
      }
      setReloads((value) => value + 1)
      void client.invalidateQueries({ queryKey: dataKeys.dataset(dataset.id) })
      void client.invalidateQueries({ queryKey: dataKeys.versions(dataset.id) })
      return {}
    },
    [client, dataset.id, t],
  )

  const writable = canEdit && dataset.settings.editable

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-line bg-surface px-2.5 py-1.5">
        <SearchInput
          value={search}
          onValueChange={setSearch}
          onClear={() => setSearch('')}
          placeholder={t('data.table.search')}
          aria-label={t('data.table.search')}
          className="h-7 w-72"
        />
        <div className="ml-auto flex items-center gap-1">
          {canExport ? (
            <Button
              variant="ghost"
              size="sm"
              icon={<Download className="size-3.5" />}
              onClick={() => setExporting(true)}
            >
              {t('data.export.action')}
            </Button>
          ) : null}
          <DataGridColumnsButton columns={columns} state={columnState} onChange={setColumnState} />
          <IconButton
            label={t('data.table.refresh')}
            size="sm"
            onClick={() => setReloads((value) => value + 1)}
          >
            <RefreshCw className="size-3.5" />
          </IconButton>
        </div>
      </div>
      {failure ? (
        <Callout tone="danger" className="m-2.5">
          {failure}
        </Callout>
      ) : null}
      <DataGrid
        aria-label={dataset.name}
        className="min-h-0 flex-1"
        columns={columns}
        rowCount={rowCount}
        totalCount={dataset.rowCount}
        getRow={getRow}
        onVisibleRangeChange={onVisibleRangeChange}
        sort={sort}
        onSortChange={setSort}
        columnState={columnState}
        onColumnStateChange={setColumnState}
        {...(writable ? { onEdit, onAppendRows } : { readOnly: true })}
        loading={loading}
        empty={
          <span className="text-sm text-fg-muted">
            {debouncedSearch
              ? t('data.table.nothingFound')
              : writable
                ? t('data.table.emptyEditable')
                : t('data.table.empty')}
          </span>
        }
        locale={locale}
        {...(me?.user.timezone ? { timezone: me.user.timezone } : {})}
      />
      {exporting ? (
        <ExportDialog
          dataset={dataset}
          view={{
            search: debouncedSearch,
            sort: sort.map((item) => ({ field: item.key, dir: item.dir })),
            // Закреплённые столбцы — первыми, как в гриде; скрытые не выгружаются
            fields: [
              ...columnState.pinned,
              ...columnState.order.filter((key) => !columnState.pinned.includes(key)),
            ].filter((key) => !columnState.hidden.includes(key)),
          }}
          onClose={() => setExporting(false)}
        />
      ) : null}
    </div>
  )
}
