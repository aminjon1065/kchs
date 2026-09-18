import type {
  FieldFormat,
  FieldSemantic,
  FieldType,
  FilterNode,
  LangText,
  QueryResultField,
  QuerySpec,
} from '@kchs/contracts'
import type { Dialect } from './dialect.js'

/** Поле датасета, как его видит компилятор: ключ, тип и физический столбец. */
export interface ResolvedField {
  key: string
  type: FieldType
  /** Физический столбец таблицы датасета (`c_<…>`). */
  physical: string
  label?: LangText | null
  semantic?: FieldSemantic | null
  format?: FieldFormat | null
}

/**
 * Политика строк для текущего пользователя (03-access-model.md): `all` — без
 * ограничений, `none` — ни одной строки, `filter` — объединение (OR) политик,
 * под которые он попал, в формате общего фильтра над полями датасета; `expr` —
 * то же условием на языке выражений (без агрегатов и параметров запроса;
 * атрибуты пользователя — `user_attr('…')` и макросы).
 */
export type RowPolicy =
  | { kind: 'all' }
  | { kind: 'none' }
  | { kind: 'filter'; where: FilterNode }
  | { kind: 'expr'; expr: string }

/** Политика столбцов для текущего пользователя: скрытые и маскированные поля. */
export interface ColumnPolicy {
  hide: readonly string[]
  mask: readonly string[]
}

/** Датасет-источник, загруженный вызывающим (схема, физическая таблица, политики). */
export interface ResolvedDataset {
  id: string
  /** Физическая таблица: `ds.t_<sid>`. */
  table: string
  fields: readonly ResolvedField[]
  rowPolicy: RowPolicy
  columnPolicy: ColumnPolicy
  /** Версия данных — часть ключа кэша результата. */
  version: number
  /**
   * Есть ли системные столбцы строк (`_id`, `_ver`, `_created_at`, `_updated_at`,
   * `_deleted_at`). У таблиц датасетов — есть; у системных представлений может не быть.
   */
  systemColumns?: boolean
}

/** Пользователь запроса: значения макросов `@me`, `@my_unit`, `@my_territories`, `user_attr()`. */
export interface CompileUser {
  id: string
  unitIds: readonly string[]
  territoryIds: readonly string[]
  subordinateIds: readonly string[]
  attributes: Readonly<Record<string, unknown>>
  /** Сотрудники подразделений пользователя — для `in_my_unit` по полю-пользователю. */
  unitMemberIds?: readonly string[]
}

export interface CompileContext {
  /** Датасеты по идентификатору: источник, соединения, объединения. */
  datasets: ReadonlyMap<string, ResolvedDataset>
  /** Системные датасеты (`tasks`, `documents`…) — представления, подготовленные вызывающим. */
  systemDatasets?: ReadonlyMap<string, ResolvedDataset>
  /** Сохранённые запросы по идентификатору (источник `query`). */
  queries?: ReadonlyMap<string, QuerySpec>
  user: CompileUser
  /** Значения параметров запроса (`@param:<name>`). */
  params?: Readonly<Record<string, unknown>>
  /** «Сейчас» — для относительных периодов, `@today`, `now()`. */
  now: Date
  /** Пояс для бакетов дат и относительных периодов; по умолчанию Asia/Dushanbe. */
  timezone?: string
  /** Потомки территории (включая её саму) — для `within` с `includeChildren`. */
  territoryDescendants?: (id: string) => readonly string[]
  /**
   * Предел строк интерактивного результата (50 000): компилятор ставит LIMIT на
   * одну строку больше, чтобы вызывающий понял `truncated`. null — без предела.
   */
  maxRows?: number | null
  /** Режим таблицы датасета: без агрегации в результат добавляются `_id` и `_ver`. */
  rowMeta?: boolean
  /** Тайм-аут по умолчанию, мс (если в спецификации не задан). */
  defaultTimeoutMs?: number
  dialect?: Dialect
}

/** Всё, от чего зависит результат, — вызывающий хэширует это в ключ кэша. */
export interface CacheKeyParts {
  /** Нормализованная спецификация (канонический JSON: ключи по алфавиту). */
  spec: string
  datasets: Array<{ id: string; version: number; policy: string }>
  /** Сохранённые запросы-источники и их спецификации. */
  queries: Array<{ id: string; spec: string }>
  /** Значения параметров, которые повлияли на запрос. */
  params: Record<string, unknown>
  /** Значения пользователя (макросы, атрибуты), которые повлияли на запрос. */
  user: Record<string, unknown>
  /** Момент с точностью до минуты, если запрос зависит от «сейчас»; иначе null. */
  time: string | null
  timezone: string
  maxRows: number | null
  rowMeta: boolean
}

export interface CompiledQuery {
  sql: string
  params: unknown[]
  fields: QueryResultField[]
  /** Число строк без завершающих сортировки и лимита — для «1 245 из 2,3 млн». */
  countSql: string
  countParams: unknown[]
  /** Предел, по которому вызывающий определяет `truncated` (строк больше — обрезано). */
  maxRows: number | null
  timeoutMs: number
  cacheKeyParts: CacheKeyParts
}

/** Источники, которые вызывающий должен загрузить до компиляции. */
export interface CollectedSources {
  datasets: string[]
  queries: string[]
  system: string[]
  /** В спецификации есть источник сырого SQL — он проходит SQL-лабораторию. */
  sql: boolean
}
