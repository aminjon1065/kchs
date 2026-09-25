import type { FieldDef, FieldFormat, FieldType, Locale } from '@kchs/contracts'
import type { ReactNode } from 'react'
import type { CellChange } from './history.js'

/** Столбец таблицы данных: поле датасета в виде, готовом к показу. */
export interface DataGridColumn {
  key: string
  /** Подпись уже на языке интерфейса. */
  label: string
  type: FieldType
  /** Ширина по умолчанию, px; иначе — по типу поля. */
  width?: number
  minWidth?: number
  format?: FieldFormat
  /** Варианты для select/multi_select: подпись вместо значения, выбор при правке. */
  options?: FieldDef['options']
  /** Ячейки правятся (для типов с текстовым вводом, если таблица не только для чтения). */
  editable?: boolean
}

/**
 * Строка: идентификатор и значения по ключам столбцов. Для датасета —
 * `_id` из rowMeta режима таблицы QuerySpec; версию строки (`_ver`) для
 * правки родитель держит у себя и находит по `id`.
 */
export interface DataGridRow {
  id: string
  values: Readonly<Record<string, unknown>>
}

export interface DataGridSortItem {
  key: string
  dir: 'asc' | 'desc'
}

export type DataGridCellChange = CellChange

/** Ответ на правку: изменения, которые сервер не принял, откатываются с причиной. */
export interface DataGridEditResult {
  rejected?: Array<{ rowId: string; key: string; message: string }>
}

/** Ответ на добавление строк: строки пакета, которые не приняты, с причиной. */
export interface DataGridAppendResult {
  rejected?: Array<{ index: number; message: string }>
}

/** Раскладка столбцов: порядок, ширины, скрытые и закреплённые слева. */
export interface DataGridColumnState {
  order: string[]
  widths: Record<string, number>
  hidden: string[]
  pinned: string[]
}

export interface DataGridSelectionInfo {
  /** Активная ячейка: индекс строки и ключ столбца. */
  active: { rowIndex: number; key: string } | null
  /** Выделено ячеек (диапазон) или строк целиком (через номер строки). */
  cells: number
  rows: number
  /** Выделенные строки отрезками индексов, границы включительно. */
  rowSpans: ReadonlyArray<readonly [number, number]>
}

export interface DataGridProps {
  columns: DataGridColumn[]
  /** Строк в результате (с учётом фильтров). */
  rowCount: number
  /** Всего строк без фильтров — для счётчика «N из M». */
  totalCount?: number
  /** Счётчик — оценка (reltuples), не точное число. */
  rowCountApprox?: boolean
  /**
   * Строка по индексу; undefined — ещё не загружена (скелет). Родитель
   * грузит окна по `onVisibleRangeChange` и передаёт новую функцию, когда
   * данные пришли, — таблица перерисует видимые строки.
   */
  getRow: (index: number) => DataGridRow | undefined
  /** Видимое окно строк с запасом [start, end) — родитель подгружает страницы. */
  onVisibleRangeChange?: (start: number, end: number) => void
  sort?: DataGridSortItem[]
  onSortChange?: (sort: DataGridSortItem[]) => void
  /**
   * Пункт «Фильтр по столбцу» в меню столбца: фильтры ведёт родитель
   * (FilterBuilder над таблицей, QuerySpec `filter`), таблица только сообщает поле.
   */
  onColumnFilter?: (key: string) => void
  /** Столбцы под фильтром родителя — значок фильтра в шапке. */
  filteredKeys?: readonly string[]
  /** Раскладка столбцов; без неё таблица хранит раскладку сама. */
  columnState?: DataGridColumnState
  onColumnStateChange?: (state: DataGridColumnState) => void
  /**
   * Правка, вставка, очистка, отмена и повтор приходят сюда пакетом; без
   * `onEdit` таблица только для чтения. До ответа таблица показывает новые
   * значения сама. Отказ по ячейкам (`rejected`: не прошла проверка, конфликт
   * версии строки) или отклонённый промис — откат ячеек, красная рамка и
   * причина в подвале. После успеха родитель обновляет свои данные и
   * передаёт новую `getRow`.
   */
  onEdit?: (changes: DataGridCellChange[]) => Promise<DataGridEditResult | undefined>
  /**
   * Новые строки из вставки ниже последней строки (или в пустую таблицу):
   * значения уже разобраны по типам столбцов, пустые ячейки пропущены,
   * строка заголовков из табличного редактора отброшена. Пакет принимается
   * целиком или отклоняется с причиной; после успеха родитель перечитывает
   * строки. Без обработчика лишние строки вставки обрезаются.
   */
  onAppendRows?: (rows: Array<Record<string, unknown>>) => Promise<DataGridAppendResult | undefined>
  onSelectionChange?: (selection: DataGridSelectionInfo) => void
  /** Открыть карточку: Enter или двойной щелчок по ячейке без правки, по номеру строки. */
  onRowOpen?: (row: DataGridRow, index: number) => void
  /** Пробел — предпросмотр строки в контекст-панели. */
  onRowPreview?: (row: DataGridRow, index: number) => void
  readOnly?: boolean
  loading?: boolean
  empty?: ReactNode
  locale?: Locale
  timezone?: string
  'aria-label': string
  className?: string
}
