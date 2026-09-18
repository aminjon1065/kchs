/** Поле таблицы в схеме автодополнения. */
export interface SqlEditorColumn {
  /** Подпись поля — «человеческое» имя, как его пишут в запросе: `Дата происшествия`. */
  label: string
  /** Ключ поля (`incident_date`): подсказка ищется и по нему. */
  key: string
  /** Подпись типа на языке интерфейса («Дата», «Число») — справа в подсказке. */
  type?: string
  /** Описание — в карточке выбранной подсказки. */
  description?: string
}

/** Таблица схемы автодополнения — датасет, доступный пользователю. */
export interface SqlEditorTable {
  /** «Человеческое» имя — название датасета, как его пишут в запросе: `Происшествия`. */
  name: string
  /** Технический ключ таблицы, если он есть: подсказка ищется и по нему. */
  key?: string
  description?: string
  columns: readonly SqlEditorColumn[]
}

/** Параметр запроса: в тексте — `{{name}}`. */
export interface SqlEditorParam {
  name: string
  /** Подпись на языке интерфейса («Начало периода») — справа в подсказке. */
  label?: string
}

/** Функция в подсказках: имя вставляется со скобками. */
export interface SqlEditorFunction {
  name: string
  /** Аргументы: `(unit, value)`; `()` — функция без аргументов. */
  signature?: string
  description?: string
}

export type SqlEditorSeverity = 'error' | 'warning' | 'info'

/**
 * Ошибка или предупреждение в тексте запроса: подчёркивание и подсказка.
 * Позиции — смещения в `value` с 0 в единицах UTF-16 (как у `String#slice`);
 * позицию ошибки Postgres (с 1, в символах) переводит `sqlPositionToOffset`.
 */
export interface SqlEditorDiagnostic {
  from: number
  /** Конец фрагмента; не задан — подчёркивается слово или знак в позиции `from`. */
  to?: number
  message: string
  /** По умолчанию `error`. */
  severity?: SqlEditorSeverity
}

/** Выделенный фрагмент запроса. */
export interface SqlEditorSelection {
  from: number
  to: number
  text: string
}

/** Методы редактора для экрана (ref). До загрузки модуля редактора вызовы ждут его. */
export interface SqlEditorHandle {
  focus(): void
  /** Вставляет текст на место выделения: имя из дерева схемы, запрос из истории. */
  insert(text: string): void
  /** Выделяет фрагмент и прокручивает к нему — например, к месту ошибки. */
  select(from: number, to?: number): void
}

export interface SqlEditorProps {
  value: string
  onChange?: (value: string) => void
  /**
   * ⌘/Ctrl+Enter — выполнить запрос. Второй аргумент — выделенный фрагмент,
   * если он есть (выполнить выделенное).
   */
  onRun?: (value: string, selection: SqlEditorSelection | null) => void
  /** Таблицы и поля для автодополнения по «человеческим» именам и ключам. */
  schema?: readonly SqlEditorTable[]
  /** Параметры `{{name}}` для автодополнения. */
  params?: readonly SqlEditorParam[]
  /** Функции для автодополнения; по умолчанию — `SQL_EDITOR_FUNCTIONS`. */
  functions?: readonly SqlEditorFunction[]
  /** Ошибки разбора и выполнения с позицией: подчёркивание и подсказка. */
  diagnostics?: readonly SqlEditorDiagnostic[]
  /** Только чтение: текст выделяется и копируется, запрос можно выполнить. */
  readOnly?: boolean
  /** Текст пустого редактора; по умолчанию — пример запроса. */
  placeholder?: string
  /** Доступное имя; по умолчанию «SQL-запрос». */
  'aria-label'?: string
  'aria-labelledby'?: string
  'aria-describedby'?: string
  /**
   * Высота, px; `auto` — по содержимому от `minHeight` до `maxHeight` (по умолчанию);
   * `fill` — по высоте родителя (панель SQL-лаборатории).
   */
  height?: number | 'auto' | 'fill'
  minHeight?: number
  maxHeight?: number
  /** Номера строк слева; по умолчанию включены. */
  lineNumbers?: boolean
  autoFocus?: boolean
  className?: string
}
