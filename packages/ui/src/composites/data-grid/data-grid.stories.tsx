import type { FieldDef, FieldType } from '@kchs/contracts'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { SearchX } from 'lucide-react'
import { useCallback, useMemo, useRef, useState } from 'react'
import { expect, userEvent, waitFor, within } from 'storybook/test'
import { EmptyState } from '../../components/feedback.js'
import {
  DataGrid,
  type DataGridCellChange,
  type DataGridColumn,
  DataGridColumnsButton,
  type DataGridEditResult,
  type DataGridRow,
  type DataGridSortItem,
  useDataGridColumnState,
} from './index.js'

const meta = {
  title: 'Композиты/Таблица данных',
  id: 'composites-data-grid',
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

// ─── Данные: районы Таджикистана, значения фиксированы ────────────────────────

const REGIONS: NonNullable<FieldDef['options']> = [
  { value: 'dushanbe', label: { ru: 'Душанбе', tg: 'Душанбе', en: 'Dushanbe' } },
  { value: 'rrp', label: { ru: 'РРП', tg: 'НТҶ', en: 'DRS' } },
  { value: 'sughd', label: { ru: 'Согдийская', tg: 'Суғд', en: 'Sughd' } },
  { value: 'khatlon', label: { ru: 'Хатлонская', tg: 'Хатлон', en: 'Khatlon' } },
  { value: 'gbao', label: { ru: 'ГБАО', tg: 'ВМКБ', en: 'GBAO' } },
]

const DISTRICTS: Array<[string, string]> = [
  ['Сино', 'dushanbe'],
  ['Фирдавси', 'dushanbe'],
  ['Шохмансур', 'dushanbe'],
  ['Исмоили Сомони', 'dushanbe'],
  ['Вахдат', 'rrp'],
  ['Гиссар', 'rrp'],
  ['Турсунзаде', 'rrp'],
  ['Шахринав', 'rrp'],
  ['Рудаки', 'rrp'],
  ['Файзабад', 'rrp'],
  ['Нурабад', 'rrp'],
  ['Рашт', 'rrp'],
  ['Варзоб', 'rrp'],
  ['Рогун', 'rrp'],
  ['Худжанд', 'sughd'],
  ['Истаравшан', 'sughd'],
  ['Пенджикент', 'sughd'],
  ['Канибадам', 'sughd'],
  ['Исфара', 'sughd'],
  ['Спитамен', 'sughd'],
  ['Зафарабад', 'sughd'],
  ['Айни', 'sughd'],
  ['Шахристан', 'sughd'],
  ['Бохтар', 'khatlon'],
  ['Куляб', 'khatlon'],
  ['Дангара', 'khatlon'],
  ['Вахш', 'khatlon'],
  ['Джайхун', 'khatlon'],
  ['Шахритус', 'khatlon'],
  ['Муминабад', 'khatlon'],
  ['Восе', 'khatlon'],
  ['Фархор', 'khatlon'],
  ['Хорог', 'gbao'],
  ['Ишкашим', 'gbao'],
  ['Рушан', 'gbao'],
  ['Шугнан', 'gbao'],
  ['Ванч', 'gbao'],
  ['Дарваз', 'gbao'],
  ['Мургаб', 'gbao'],
]

const NOTES = [
  'Паводок в апреле, восстановлены две дамбы',
  null,
  'Данные уточняются',
  null,
  'Сверено с отчётом хукумата',
]

/** Детерминированное «случайное» число 0…1 по номеру строки и столбца. */
function noise(row: number, col: number): number {
  let x = (row * 374_761_393 + col * 668_265_263) | 0
  x = Math.imul(x ^ (x >>> 13), 1_274_126_177)
  x ^= x >>> 16
  return (x >>> 0) / 2 ** 32
}

const DAY_MS = 86_400_000
const YEAR_START = Date.UTC(2026, 0, 1)

function isoDate(offsetDays: number): string {
  return new Date(YEAR_START + offsetDays * DAY_MS).toISOString().slice(0, 10)
}

const DISTRICT_ROWS: DataGridRow[] = DISTRICTS.map(([name, region], index) => ({
  id: `d${index + 1}`,
  values: {
    district: name,
    region,
    population: Math.round(40_000 + noise(index, 1) * 360_000),
    area: Math.round(300 + noise(index, 2) * 38_000) / 10,
    budget: Math.round(noise(index, 3) * 90_000_000) / 100,
    share: Math.round(noise(index, 4) * 60) / 1000,
    reportDate: isoDate(200 + Math.floor(noise(index, 5) * 60)),
    updatedAt: new Date(
      YEAR_START + (240 + Math.floor(noise(index, 6) * 20)) * DAY_MS + 9 * 3_600_000,
    ).toISOString(),
    verified: noise(index, 7) > 0.35,
    code: `TJ-${String(101 + index * 7)}`,
    note: NOTES[index % NOTES.length],
  },
}))

const DISTRICT_COLUMNS: DataGridColumn[] = [
  { key: 'district', label: 'Район', type: 'text', width: 160, editable: true },
  { key: 'region', label: 'Регион', type: 'select', options: REGIONS, width: 140, editable: true },
  { key: 'population', label: 'Население', type: 'integer', editable: true },
  {
    key: 'area',
    label: 'Площадь, км²',
    type: 'number',
    format: { precision: 1 },
    width: 130,
    editable: true,
  },
  {
    key: 'budget',
    label: 'Бюджет, тыс. сомони',
    type: 'money',
    format: { precision: 2 },
    width: 170,
    editable: true,
  },
  { key: 'share', label: 'Доля бюджета', type: 'percent', width: 130, editable: true },
  { key: 'reportDate', label: 'Дата отчёта', type: 'date', width: 124, editable: true },
  { key: 'updatedAt', label: 'Обновлено', type: 'datetime' },
  { key: 'verified', label: 'Проверено', type: 'boolean', width: 110, editable: true },
  { key: 'code', label: 'Код', type: 'identifier', width: 100 },
  { key: 'note', label: 'Примечание', type: 'long_text', editable: true },
]

/** Серверная сортировка в демонстрации: таблица только сообщает порядок. */
function sortOrder(rows: DataGridRow[], sort: DataGridSortItem[]): number[] {
  const order = rows.map((_, index) => index)
  if (sort.length === 0) return order
  return order.sort((a, b) => {
    for (const { key, dir } of sort) {
      const left = rows[a]?.values[key]
      const right = rows[b]?.values[key]
      const result =
        typeof left === 'number' && typeof right === 'number'
          ? left - right
          : String(left ?? '').localeCompare(String(right ?? ''), 'ru')
      if (result !== 0) return dir === 'asc' ? result : -result
    }
    return 0
  })
}

/** «Сервер»: принимает правки, кроме отрицательного населения. */
function applyEdits(
  rows: DataGridRow[],
  changes: DataGridCellChange[],
): { rows: DataGridRow[]; result: DataGridEditResult } {
  const rejected = changes
    .filter((change) => change.key === 'population' && Number(change.value) < 0)
    .map((change) => ({
      rowId: change.rowId,
      key: change.key,
      message: 'население не может быть отрицательным',
    }))
  const accepted = changes.filter(
    (change) => !rejected.some((item) => item.rowId === change.rowId && item.key === change.key),
  )
  const next = rows.map((row) => {
    const updates = accepted.filter((change) => change.rowId === row.id)
    if (updates.length === 0) return row
    const values = { ...row.values }
    for (const change of updates) values[change.key] = change.value
    return { id: row.id, values }
  })
  return { rows: next, result: { rejected } }
}

function DistrictsGrid({
  editable = false,
  initialSort = [],
  hidden = [],
  withColumnsButton = false,
}: {
  editable?: boolean
  initialSort?: DataGridSortItem[]
  hidden?: string[]
  withColumnsButton?: boolean
}) {
  const [rows, setRows] = useState(DISTRICT_ROWS)
  const rowsRef = useRef(rows)
  rowsRef.current = rows
  const [sort, setSort] = useState(initialSort)
  const [columnState, setColumnState] = useDataGridColumnState(DISTRICT_COLUMNS, {
    pinned: ['district'],
    hidden,
  })
  const order = useMemo(() => sortOrder(rows, sort), [rows, sort])
  const getRow = useCallback((index: number) => rows[order[index] ?? -1], [rows, order])
  const onEdit = useCallback(async (changes: DataGridCellChange[]) => {
    const { rows: next, result } = applyEdits(rowsRef.current, changes)
    setRows(next)
    return result
  }, [])

  return (
    <div className="flex flex-col gap-2">
      {withColumnsButton ? (
        <div className="flex justify-end">
          <DataGridColumnsButton
            columns={DISTRICT_COLUMNS}
            state={columnState}
            onChange={setColumnState}
          />
        </div>
      ) : null}
      <DataGrid
        aria-label="Районы"
        className="h-[420px] rounded-md border border-line"
        columns={DISTRICT_COLUMNS}
        rowCount={rows.length}
        getRow={getRow}
        sort={sort}
        onSortChange={setSort}
        columnState={columnState}
        onColumnStateChange={setColumnState}
        onEdit={editable ? onEdit : undefined}
        // Фильтры ведёт экран (FilterBuilder над таблицей) — в демонстрации пункт меню без действия
        onColumnFilter={() => undefined}
        timezone="Asia/Dushanbe"
      />
    </div>
  )
}

function gridOf(canvasElement: HTMLElement, name = 'Районы'): HTMLElement {
  return within(canvasElement).getByRole('grid', { name })
}

function cellOf(grid: HTMLElement, row: number, col: number): HTMLElement {
  const cell = grid.querySelector<HTMLElement>(`[data-row="${row}"] [data-col="${col}"]`)
  if (!cell) throw new Error(`нет ячейки ${row}:${col}`)
  return cell
}

// ─── Истории ─────────────────────────────────────────────────────────────────

export const Basic: Story = {
  name: 'Базовая: типы полей, закреплённый столбец, сортировка',
  render: () => <DistrictsGrid editable initialSort={[{ key: 'population', dir: 'desc' }]} />,
}

export const EditAndPaste: Story = {
  name: 'Правка и вставка из буфера',
  render: () => <DistrictsGrid editable />,
  play: async ({ canvasElement }) => {
    const grid = gridOf(canvasElement)
    const status = within(canvasElement).getByRole('status')
    // Вставка блока 3×2 из Excel в «Население» и «Площадь»: одно значение не число
    await userEvent.click(cellOf(grid, 1, 2))
    const data = new DataTransfer()
    data.setData('text/plain', '250 000\t1 234,5\r\n98 500\tмного\r\n180000\t980,25\r\n')
    grid.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    )
    await waitFor(() => expect(status).toHaveTextContent('Вставлено 5 значений'))
    await expect(status).toHaveTextContent('не распознано 1 значение: «много» (Площадь, км²)')
    // Правка набором: сервер отклоняет отрицательное население — ячейка откатывается
    await userEvent.click(cellOf(grid, 6, 2))
    await userEvent.keyboard('-10{Enter}')
    await waitFor(() =>
      expect(status).toHaveTextContent('Не сохранено: население не может быть отрицательным'),
    )
  },
}

export const CellEditor: Story = {
  name: 'Правка ячейки: выбор из справочника',
  render: () => <DistrictsGrid editable />,
  play: async ({ canvasElement }) => {
    const grid = gridOf(canvasElement)
    await userEvent.click(cellOf(grid, 3, 1))
    await userEvent.keyboard('{Enter}{ArrowDown}')
    await within(document.body).findByRole('listbox', { name: 'Регион' })
  },
}

export const SelectionSummary: Story = {
  name: 'Выделение диапазона и сводка',
  render: () => <DistrictsGrid />,
  play: async ({ canvasElement }) => {
    const grid = gridOf(canvasElement)
    await userEvent.click(cellOf(grid, 2, 2))
    await userEvent.keyboard('{Shift>}{ArrowDown}{ArrowDown}{ArrowDown}{ArrowRight}{/Shift}')
    await waitFor(() => expect(canvasElement).toHaveTextContent('Выделено: 8'))
  },
}

export const ColumnMenu: Story = {
  name: 'Меню столбца',
  render: () => <DistrictsGrid />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: 'Меню столбца «Население»' }))
    await within(document.body).findByRole('menuitem', { name: 'Закрепить слева' })
  },
}

export const ColumnsPanel: Story = {
  name: 'Панель «Столбцы»',
  render: () => <DistrictsGrid hidden={['code', 'note']} withColumnsButton />,
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: /Столбцы/ }))
    await within(document.body).findByRole('checkbox', { name: 'Примечание' })
  },
}

// ─── Большой набор: 100 столбцов × 100 000 строк с загрузкой окнами ─────────

const LARGE_ROWS = 100_000
const PAGE_SIZE = 200
const LARGE_TYPES: FieldType[] = [
  'integer',
  'number',
  'money',
  'percent',
  'date',
  'text',
  'boolean',
  'select',
  'datetime',
  'decimal',
]

const LARGE_COLUMNS: DataGridColumn[] = [
  { key: 'id', label: 'Запись', type: 'identifier', width: 100 },
  ...Array.from({ length: 99 }, (_, index): DataGridColumn => {
    const type = LARGE_TYPES[index % LARGE_TYPES.length] as FieldType
    return {
      key: `c${index + 1}`,
      label: `Показатель ${index + 1}`,
      type,
      options: type === 'select' ? REGIONS : undefined,
      format: type === 'money' || type === 'decimal' ? { precision: 2 } : undefined,
      editable: true,
    }
  }),
]

function largeValue(type: FieldType, row: number, col: number): unknown {
  const r = noise(row, col)
  switch (type) {
    case 'integer':
      return Math.floor(r * 100_000)
    case 'number':
      return Math.round(r * 100_000) / 100
    case 'money':
    case 'decimal':
      return Math.round(r * 10_000_000) / 100
    case 'percent':
      return Math.round(r * 1000) / 1000
    case 'date':
      return isoDate(Math.floor(r * 365))
    case 'datetime':
      return new Date(YEAR_START + Math.floor(r * 365 * 24) * 3_600_000).toISOString()
    case 'boolean':
      return r > 0.5
    case 'select':
      return REGIONS[Math.floor(r * REGIONS.length)]?.value
    default:
      return DISTRICTS[Math.floor(r * DISTRICTS.length)]?.[0]
  }
}

function largeRow(row: number): DataGridRow {
  const values: Record<string, unknown> = { id: `R-${String(row + 1).padStart(6, '0')}` }
  LARGE_COLUMNS.forEach((column, col) => {
    if (col > 0) values[column.key] = largeValue(column.type, row, col)
  })
  return { id: String(row), values }
}

function largePage(page: number): DataGridRow[] {
  const rows: DataGridRow[] = []
  const end = Math.min(LARGE_ROWS, (page + 1) * PAGE_SIZE)
  for (let row = page * PAGE_SIZE; row < end; row++) rows.push(largeRow(row))
  return rows
}

/**
 * Загрузка окнами, как у экрана датасета: первая страница есть сразу, остальные
 * «приходят с сервера» через `latency` мс — до этого строки показаны скелетом.
 * `latency: 0` — все строки сразу (замер отрисовки без скелетов, visual/grid-perf.spec.ts).
 */
function LargeGrid({ latency }: { latency: number }) {
  const [pages, setPages] = useState(() => new Map([[0, largePage(0)]]))
  const requested = useRef(new Set([0]))
  const generated = useRef(new Map<number, DataGridRow>())
  const [columnState, setColumnState] = useDataGridColumnState(LARGE_COLUMNS, { pinned: ['id'] })
  const getRow = useCallback(
    (index: number) => {
      if (latency > 0) return pages.get(Math.floor(index / PAGE_SIZE))?.[index % PAGE_SIZE]
      // Без задержки строка создаётся по запросу и запоминается — как готовый кэш
      let row = generated.current.get(index)
      if (!row) {
        row = largeRow(index)
        generated.current.set(index, row)
      }
      return row
    },
    [pages, latency],
  )
  const onVisibleRangeChange = useCallback(
    (start: number, end: number) => {
      if (latency <= 0) return
      // Окно и одна страница вперёд
      const last = Math.min(
        Math.floor((end - 1) / PAGE_SIZE) + 1,
        Math.floor((LARGE_ROWS - 1) / PAGE_SIZE),
      )
      for (let page = Math.floor(start / PAGE_SIZE); page <= last; page++) {
        if (requested.current.has(page)) continue
        requested.current.add(page)
        setTimeout(
          () => setPages((current) => new Map(current).set(page, largePage(page))),
          latency,
        )
      }
    },
    [latency],
  )
  const onEdit = useCallback(async () => ({}), [])

  return (
    <DataGrid
      aria-label="Показатели"
      className="h-[520px] rounded-md border border-line"
      columns={LARGE_COLUMNS}
      rowCount={LARGE_ROWS}
      totalCount={1_250_000}
      getRow={getRow}
      onVisibleRangeChange={onVisibleRangeChange}
      columnState={columnState}
      onColumnStateChange={setColumnState}
      onEdit={onEdit}
      timezone="Asia/Dushanbe"
    />
  )
}

export const Large: StoryObj<{ latency: number }> = {
  name: 'Большой набор: 100 столбцов × 100 000 строк',
  args: { latency: 120 },
  render: ({ latency }) => <LargeGrid latency={Number(latency)} />,
}

// ─── Состояния ──────────────────────────────────────────────────────────────

export const Empty: Story = {
  name: 'Пусто',
  render: () => (
    <DataGrid
      aria-label="Районы"
      className="h-[320px] rounded-md border border-line"
      columns={DISTRICT_COLUMNS}
      rowCount={0}
      totalCount={39}
      getRow={() => undefined}
      empty={
        <EmptyState
          compact
          icon={<SearchX className="size-5" />}
          title="Ничего не найдено"
          description="Измените условия фильтра."
        />
      }
    />
  ),
}

export const Loading: Story = {
  name: 'Загрузка',
  render: () => (
    <DataGrid
      aria-label="Районы"
      className="h-[320px] rounded-md border border-line"
      columns={DISTRICT_COLUMNS}
      rowCount={0}
      getRow={() => undefined}
      loading
    />
  ),
}
