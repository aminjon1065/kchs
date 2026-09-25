import type {
  DatasetRecord,
  DatasetRow,
  DatasetRowsQuery,
  FilterNode,
  QueryResult,
} from '@kchs/contracts'
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
  type DataGridSelectionInfo,
  type DataGridSortItem,
  FilterBuilder,
  type FilterFieldRequest,
  IconButton,
  SearchInput,
  Switch,
  useDataGridColumnState,
  useDebouncedValue,
} from '@kchs/ui'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, Link2, Plus, RefreshCw, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import {
  idsOfSpans,
  useLinkedDataset,
  useLinkSource,
  usePaneLinkGroup,
  useViewContext,
} from '~/app/workspace/view-context.js'
import { useTerritoryFilterEditor } from '~/features/gis/territory-filter.js'
import { ApiError, http } from '~/shared/api/client.js'
import { meQuery } from '~/shared/api/queries.js'
import { ExportDialog } from './export-dialog.js'
import { useFieldOptions } from './field-options.js'
import { filterFieldsOf } from './field-types.js'
import { dataKeys } from './queries.js'
import { NewRowDialog, RowCard } from './row-card.js'

/** Строк в странице таблицы: грид просит окна, страницы грузятся по мере прокрутки. */
const PAGE = 200

/** Поля, по которым фильтр столбца не строится: геометрия — на карте, JSON — в данных. */
const NOT_FILTERABLE = new Set(['geometry', 'json'])

/** Поля условий фильтра — для значка фильтра в шапке столбца. */
function filterKeys(node: FilterNode | null, out = new Set<string>()): Set<string> {
  if (!node) return out
  if ('field' in node) out.add(node.field)
  else if ('not' in node) filterKeys(node.not, out)
  else for (const child of 'and' in node ? node.and : node.or) filterKeys(child, out)
  return out
}

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
  // Фильтры по столбцам: чипы над таблицей, «Фильтр по столбцу» в меню столбца
  const [filter, setFilter] = useState<FilterNode | null>(null)
  const [filterRequest, setFilterRequest] = useState<FilterFieldRequest | null>(null)
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
  const [openRow, setOpenRow] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const canExport = me?.capabilities.includes('data.export') ?? false

  // Связанные представления (ADR-0073): фильтр и охват соседних панелей сужают
  // таблицу, выделение строк уходит к ним (карта подсвечивает объекты)
  const group = usePaneLinkGroup()
  const source = useLinkSource(group)
  const linked = useLinkedDataset(group, dataset.id)
  const linkedFilter = linked.filter && linked.filter.source !== source ? linked.filter : null
  const linkedExtent = linked.extent && linked.extent.source !== source ? linked.extent : null
  const linkedSelection =
    linked.selection && linked.selection.source !== source && linked.selection.ids.length > 0
      ? linked.selection
      : null
  const [inExtent, setInExtent] = useState(false)
  const [onlyLinked, setOnlyLinked] = useState(false)
  const conditions: FilterNode[] = [
    ...(filter ? [filter] : []),
    ...(linkedFilter ? [linkedFilter.where] : []),
    ...(onlyLinked && linkedSelection
      ? [{ field: '_id', op: 'in' as const, value: linkedSelection.ids.map(Number) }]
      : []),
  ]
  const where = conditions.length > 1 ? { and: conditions } : conditions[0]
  const whereKey = where ? JSON.stringify(where) : ''
  const bbox =
    inExtent && linkedExtent ? { field: linkedExtent.field, bbox: linkedExtent.bbox } : null
  const bboxKey = bbox ? JSON.stringify(bbox) : ''

  // Территории и справочники: подпись вместо значения, выбор при правке (ADR-0057)
  const fieldOptions = useFieldOptions(dataset.fields)
  const columns = useMemo<DataGridColumn[]>(
    () =>
      dataset.fields.map((field) => {
        const options = fieldOptions.get(field.key) ?? field.options
        return {
          key: field.key,
          label: field.label[locale] ?? field.label.ru ?? field.key,
          type: field.type,
          ...(field.format ? { format: field.format } : {}),
          ...(options ? { options } : {}),
          editable: canEdit && dataset.settings.editable && !field.readOnly,
        }
      }),
    [dataset.fields, dataset.settings.editable, canEdit, locale, fieldOptions],
  )
  const [columnState, setColumnState] = useDataGridColumnState(columns)
  const filterFields = useMemo(
    () =>
      filterFieldsOf(dataset.fields, locale, fieldOptions).filter(
        (field) => !NOT_FILTERABLE.has(field.type),
      ),
    [dataset.fields, locale, fieldOptions],
  )
  const territoryEditor = useTerritoryFilterEditor(
    dataset.fields.some((field) => field.type === 'territory'),
  )
  const filteredKeys = useMemo(() => [...filterKeys(filter)], [filter])

  const load = useCallback(
    async (page: number, current: number) => {
      requested.current.add(page)
      const body: DatasetRowsQuery = {
        ...(whereKey ? { where: JSON.parse(whereKey) as FilterNode } : {}),
        ...(bboxKey ? { bbox: JSON.parse(bboxKey) as NonNullable<DatasetRowsQuery['bbox']> } : {}),
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
    [dataset.id, sort, debouncedSearch, whereKey, bboxKey, t],
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

  // Выделенные строки (и строка активной ячейки) — соседним панелям группы
  const rowAt = useRef(getRow)
  rowAt.current = getRow
  const onSelectionChange = useCallback(
    (info: DataGridSelectionInfo) => {
      if (!group) return
      const ids = idsOfSpans(info.rowSpans, (index) => rowAt.current(index)?.id)
      useViewContext.getState().select(group, dataset.id, ids, source)
    },
    [group, dataset.id, source],
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

  /** Строка изменилась в карточке — таблица, счётчик и версии перечитываются. */
  const refresh = useCallback(() => {
    setReloads((value) => value + 1)
    void client.invalidateQueries({ queryKey: dataKeys.dataset(dataset.id) })
    void client.invalidateQueries({ queryKey: dataKeys.versions(dataset.id) })
  }, [client, dataset.id])

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
          {writable ? (
            <Button
              variant="ghost"
              size="sm"
              icon={<Plus className="size-3.5" />}
              onClick={() => setCreating(true)}
            >
              {t('data.row.add')}
            </Button>
          ) : null}
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
      <div className="shrink-0 border-b border-line bg-surface px-2.5 py-1.5">
        <FilterBuilder
          fields={filterFields}
          value={filter}
          onChange={setFilter}
          renderValue={territoryEditor}
          request={filterRequest}
        />
      </div>
      {group && (linkedExtent || linkedSelection || linkedFilter) ? (
        <section
          aria-label={t('data.table.linked.title')}
          className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b border-line bg-surface-2 px-2.5 py-1"
        >
          <span className="flex items-center gap-1.5 whitespace-nowrap text-xs font-medium text-fg-secondary">
            <Link2 className="size-3.5 shrink-0 text-accent" aria-hidden />
            {t('data.table.linked.title')}
          </span>
          {linkedExtent ? (
            <Switch
              checked={inExtent}
              onCheckedChange={(checked) => setInExtent(checked)}
              label={
                <span className="whitespace-nowrap text-xs text-fg-secondary">
                  {t('data.table.linked.inExtent')}
                </span>
              }
            />
          ) : null}
          {linkedSelection ? (
            <Switch
              checked={onlyLinked}
              onCheckedChange={(checked) => setOnlyLinked(checked)}
              label={
                <span className="whitespace-nowrap text-xs text-fg-secondary">
                  {t('data.table.linked.onlySelected', { count: linkedSelection.ids.length })}
                </span>
              }
            />
          ) : null}
          {linkedFilter ? (
            <span className="flex min-w-0 max-w-96 items-center gap-1 rounded-sm border border-line bg-surface py-0.5 pl-1.5 pr-0.5 text-xs text-fg-secondary">
              <span className="truncate">
                {t('data.table.linked.filter', { label: linkedFilter.label })}
              </span>
              <IconButton
                label={t('data.table.linked.clearFilter')}
                size="sm"
                onClick={() =>
                  useViewContext.getState().filter(group, dataset.id, null, source, true)
                }
              >
                <X className="size-3" aria-hidden />
              </IconButton>
            </span>
          ) : null}
        </section>
      ) : null}
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
        onColumnFilter={(key) => setFilterRequest({ field: key, nonce: Date.now() })}
        filteredKeys={filteredKeys}
        columnState={columnState}
        onColumnStateChange={setColumnState}
        {...(writable ? { onEdit, onAppendRows } : { readOnly: true })}
        onSelectionChange={onSelectionChange}
        onRowOpen={(row) => setOpenRow(row.id)}
        loading={loading}
        empty={
          <span className="text-sm text-fg-muted">
            {debouncedSearch || where
              ? t('data.table.nothingFound')
              : writable
                ? t('data.table.emptyEditable')
                : t('data.table.empty')}
          </span>
        }
        locale={locale}
        {...(me?.user.timezone ? { timezone: me.user.timezone } : {})}
      />
      {openRow ? (
        <RowCard
          dataset={dataset}
          rowId={openRow}
          canEdit={canEdit}
          onClose={() => setOpenRow(null)}
          onChanged={refresh}
        />
      ) : null}
      {creating ? (
        <NewRowDialog
          dataset={dataset}
          onClose={() => setCreating(false)}
          onCreated={(rowId) => {
            setCreating(false)
            refresh()
            if (rowId) setOpenRow(rowId)
          }}
        />
      ) : null}
      {exporting ? (
        <ExportDialog
          dataset={dataset}
          view={{
            ...(where ? { where } : {}),
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
