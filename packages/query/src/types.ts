import type {
  FieldFormat,
  FieldSemantic,
  FieldType,
  FilterNode,
  LangText,
  QueryParam,
  QueryResultField,
  QuerySpec,
  TerritoryLevel,
} from '@kchs/contracts'
import type { Dialect } from './dialect.js'

/** Ссылка поля на справочник: значение — ключ строки справочника (`lookup_label`). */
export interface LookupRef {
  datasetId: string
  keyField: string
  labelField: string
}

/** Поле датасета, как его видит компилятор: ключ, тип и физический столбец. */
export interface ResolvedField {
  key: string
  type: FieldType
  /** Физический столбец таблицы датасета (`c_<…>`). */
  physical: string
  label?: LangText | null
  semantic?: FieldSemantic | null
  format?: FieldFormat | null
  lookup?: LookupRef | null
}

/**
 * Справочная подстановка функций выражений (ADR-0057): `territory_level`,
 * `territory_name` (по идентификатору территории или её коду) и `lookup_label`.
 */
export type ReferenceRequest =
  | { kind: 'territory_level'; level: TerritoryLevel; key: 'id' | 'code' }
  | { kind: 'territory_name'; key: 'id' | 'code' }
  | ({ kind: 'lookup_label' } & LookupRef)

/** Подстановка «значение текстом → результат» и версия данных, из которых она собрана. */
export interface ReferenceMap {
  values: Readonly<Record<string, string>>
  /** Часть ключа кэша: меняется вместе со справочником (и языком подписей). */
  version: string
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

/** Рамка WGS 84 [запад, юг, восток, север] на поле геометрии датасета. */
export interface SpatialWindow {
  datasetId: string
  field: string
  bbox: readonly [number, number, number, number]
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
   * Справочные подстановки функций выражений. Нет нужной — компиляция завершается
   * `MissingReferencesError` со списком: вызывающий загружает их и повторяет её.
   */
  references?: (request: ReferenceRequest) => ReferenceMap | undefined
  /**
   * Предел строк интерактивного результата (50 000): компилятор ставит LIMIT на
   * одну строку больше, чтобы вызывающий понял `truncated`. null — без предела.
   */
  maxRows?: number | null
  /** Режим таблицы датасета: без агрегации в результат добавляются `_id` и `_ver`. */
  rowMeta?: boolean
  /**
   * Геометрия в результате: GeoJSON (по умолчанию — клиенту) или как есть — для
   * обёртки вызывающим (векторные тайлы `ST_AsMVT`, ADR-0064).
   */
  geometryOutput?: 'geojson' | 'raw'
  /**
   * Пространственное окно вызывающего (тайлы и объекты слоя в охвате, ADR-0064):
   * пересечение рамок `&&` на поле геометрии датасета — в базовом подзапросе
   * вместе с политикой строк, до барьера `OFFSET 0`, чтобы работал индекс GIST.
   * Только значения сервера: рамка из чисел и видимое поле геометрии; условия
   * пользователя по-прежнему вычисляются после политики.
   */
  spatialWindow?: SpatialWindow
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
  /** Справочные подстановки запроса и версии их данных. */
  references: Array<{ key: string; version: string }>
  /** Момент с точностью до минуты, если запрос зависит от «сейчас»; иначе null. */
  time: string | null
  timezone: string
  maxRows: number | null
  rowMeta: boolean
  /** Есть, только если геометрия отдаётся как есть: иначе ключи прежних версий не меняются. */
  geometryOutput?: 'raw'
  /** Пространственное окно вызывающего — есть, только если задано. */
  spatialWindow?: { datasetId: string; field: string; bbox: number[] }
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

/**
 * Датасет SQL-лаборатории: как для компилятора плюс «человеческое» имя таблицы.
 * В запросе пишут `SELECT … FROM "Происшествия"`, а не физическое `ds.t_…`.
 */
export interface SqlDataset extends ResolvedDataset {
  /** Название датасета — имя таблицы в SQL (сравнение точное, затем без учёта регистра). */
  name: string
  /** Другие имена таблицы (короткое имя, прежнее название) — по желанию вызывающего. */
  aliases?: readonly string[]
}

/** Контекст компиляции сырого SQL: пользователь, параметры, время — как у QuerySpec. */
export interface RawSqlContext
  extends Omit<CompileContext, 'datasets' | 'systemDatasets' | 'queries' | 'rowMeta'> {
  /** Датасеты, доступные пользователю, с его политиками строк и столбцов. */
  datasets: readonly SqlDataset[]
  /** Объявления параметров `{{имя}}`: тип, значение по умолчанию, обязательность. */
  paramDefs?: Readonly<Record<string, QueryParam>>
}

/** Столбец результата сырого SQL, насколько его можно вывести без выполнения. */
export interface RawSqlColumn {
  /** Имя столбца (как его назовёт Postgres); null — известно только после выполнения. */
  name: string | null
  /** Описание поля датасета, если столбец — прямая ссылка на него (тип, подпись, формат). */
  field: QueryResultField | null
}

/** Участок итогового SQL и его место в исходном тексте (индексы строки JavaScript). */
export interface SqlSourceSegment {
  /** Начало участка в `CompiledRawSql.sql`. */
  at: number
  /** Начало соответствующего места в исходном тексте. */
  source: number
  length: number
  /** true — текст пользователя без изменений; false — подстановка на месте имени или параметра. */
  exact: boolean
}

export interface CompiledRawSql {
  /** Запрос с подзапросами-политиками вместо имён датасетов и `LIMIT maxRows + 1`. */
  sql: string
  params: unknown[]
  /** Карта участков `sql` → исходный текст — для позиций ошибок Postgres (`rawSqlErrorPosition`). */
  sourceMap: SqlSourceSegment[]
  /** Столбцы результата по порядку; null — список известен только после выполнения. */
  fields: RawSqlColumn[] | null
  countSql: string
  countParams: unknown[]
  maxRows: number | null
  timeoutMs: number
  /** Пояс запроса: вызывающий ставит его сеансу (`set_config('TimeZone', …, true)`). */
  timezone: string
  /** Датасеты, к которым обращается запрос (идентификаторы). */
  datasets: string[]
  /** false — в запросе random() и т. п.: результат не кэшируется. */
  cacheable: boolean
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
