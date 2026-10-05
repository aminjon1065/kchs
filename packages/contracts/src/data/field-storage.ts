import { STORED_FIELD_TYPES, type StoredFieldType } from './dataset.js'

/**
 * Хранение полей датасета — один реестр для api, компилятора запросов и движка
 * (ADR-0190). Раньше одно и то же соответствие «тип поля → тип столбца» жило в
 * пяти местах на двух языках и расходилось; теперь его читают `data/infra/physical.ts`
 * (Postgres), `@kchs/query` (DuckDB), колоночная копия и геовыгрузка движка
 * (`field_types.json`, `pnpm --filter @kchs/contracts gen:engine`).
 */

/** Точность и масштаб `decimal`/`money` в колоночной копии Parquet и в DuckDB (ADR-0109). */
export const COLUMNAR_DECIMAL = { precision: 38, scale: 12 } as const

/**
 * Длительность в колоночной копии и в выражениях компилятора — число минут
 * (`double`), а не интервал: DuckDB и Parquet не хранят интервал Postgres.
 */
export const DURATION_UNIT = 'minute' as const

/** Типы Arrow колоночной копии: движок переводит их в типы `pyarrow`. */
export const ARROW_TYPES = [
  'string',
  'int64',
  'float64',
  'decimal',
  'bool',
  'date32',
  'timestamp_utc',
  'time64',
  'list_string',
] as const
export type ArrowType = (typeof ARROW_TYPES)[number]

/** Семейство значений геовыгрузки (Shapefile, GeoPackage, GeoJSON, KML). */
export const EXPORT_FAMILIES = [
  'integer',
  'real',
  'boolean',
  'date',
  'datetime',
  'text',
  // Геометрия поля — сама геометрия слоя, а не атрибут
  'geometry',
] as const
export type ExportFamily = (typeof EXPORT_FAMILIES)[number]

export interface FieldStorage {
  /** Тип столбца таблицы `ds.t_*`; у `decimal` точность задаёт поле. */
  pg: string
  /** Тип в колоночной копии; `null` — поле в копии не хранится (геометрия). */
  arrow: ArrowType | null
  /** Тип столбца копии, каким его видит DuckDB; `null` — не хранится. */
  duckdb: string | null
  /** Как значение пишется в геоформат. */
  exportFamily: ExportFamily
}

const DECIMAL_DUCKDB = `DECIMAL(${COLUMNAR_DECIMAL.precision},${COLUMNAR_DECIMAL.scale})`
const text: FieldStorage = { pg: 'text', arrow: 'string', duckdb: 'VARCHAR', exportFamily: 'text' }
/** Ссылки (пользователь, подразделение, территория, объект, файл) — `uuid`, в копии — строки. */
const reference: FieldStorage = {
  pg: 'uuid',
  arrow: 'string',
  duckdb: 'VARCHAR',
  exportFamily: 'text',
}

export const FIELD_STORAGE: Record<StoredFieldType, FieldStorage> = {
  text,
  long_text: text,
  select: text,
  identifier: text,
  url: text,
  email: text,
  phone: text,
  integer: { pg: 'bigint', arrow: 'int64', duckdb: 'BIGINT', exportFamily: 'integer' },
  number: { pg: 'double precision', arrow: 'float64', duckdb: 'DOUBLE', exportFamily: 'real' },
  percent: { pg: 'double precision', arrow: 'float64', duckdb: 'DOUBLE', exportFamily: 'real' },
  decimal: { pg: 'numeric', arrow: 'decimal', duckdb: DECIMAL_DUCKDB, exportFamily: 'real' },
  money: { pg: 'numeric(18, 2)', arrow: 'decimal', duckdb: DECIMAL_DUCKDB, exportFamily: 'real' },
  boolean: { pg: 'boolean', arrow: 'bool', duckdb: 'BOOLEAN', exportFamily: 'boolean' },
  date: { pg: 'date', arrow: 'date32', duckdb: 'DATE', exportFamily: 'date' },
  datetime: {
    pg: 'timestamptz',
    arrow: 'timestamp_utc',
    duckdb: 'TIMESTAMPTZ',
    exportFamily: 'datetime',
  },
  time: { pg: 'time', arrow: 'time64', duckdb: 'TIME', exportFamily: 'text' },
  // Копия хранит минуты (`DURATION_UNIT`), геовыгрузка — текст интервала
  duration: { pg: 'interval', arrow: 'float64', duckdb: 'DOUBLE', exportFamily: 'text' },
  multi_select: { pg: 'text[]', arrow: 'list_string', duckdb: 'VARCHAR[]', exportFamily: 'text' },
  user: reference,
  unit: reference,
  territory: reference,
  object_ref: reference,
  file: reference,
  // JSON — строкой в копии: сравнение и группировка посимвольные
  json: { pg: 'jsonb', arrow: 'string', duckdb: 'VARCHAR', exportFamily: 'text' },
  geometry: {
    pg: 'geometry(Geometry, 4326)',
    arrow: null,
    duckdb: null,
    exportFamily: 'geometry',
  },
}

/** Типы полей колоночной копии: всё, что хранит Arrow (геометрия остаётся в Postgres). */
export type ColumnarFieldType = Exclude<StoredFieldType, 'geometry'>
export const COLUMNAR_FIELD_TYPES = STORED_FIELD_TYPES.filter(
  (type): type is ColumnarFieldType => FIELD_STORAGE[type].arrow !== null,
)

export function isColumnarFieldType(type: string): type is ColumnarFieldType {
  return (COLUMNAR_FIELD_TYPES as readonly string[]).includes(type)
}

/** Тип столбца Postgres поля; `decimal` — с точностью поля (до 12 знаков). */
export function pgColumnType(type: StoredFieldType, precision?: number): string {
  if (type === 'decimal' && precision !== undefined) {
    return `numeric(38, ${Math.min(precision, 12)})`
  }
  return FIELD_STORAGE[type].pg
}
