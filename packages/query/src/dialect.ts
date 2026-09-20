import { UnsupportedByDialectError } from './errors.js'

/**
 * Диалект SQL. Компилятор пишет запрос через эти примитивы: Postgres —
 * основное хранилище, DuckDB — колоночный tier поверх Parquet
 * (06-analytics-engine.md §5, ADR-0109).
 */
export type DateUnit = 'year' | 'quarter' | 'month' | 'week' | 'day' | 'hour'
export type DatePart = 'year' | 'quarter' | 'month' | 'week' | 'day' | 'dow' | 'hour'
export type IntervalUnit = 'year' | 'quarter' | 'month' | 'week' | 'day' | 'hour' | 'minute'

export interface Dialect {
  readonly name: 'postgres' | 'duckdb'
  /** Идентификатор в кавычках; допускаются только проверенные имена. */
  ident(name: string): string
  /** Физическая таблица `schema.table`. */
  table(ref: string): string
  /** Позиционный параметр ($1). */
  placeholder(index: number): string
  cast(sql: string, type: string): string
  /** Регистронезависимое сравнение с шаблоном LIKE (экранирование — `\`). */
  ilike(sql: string, pattern: string): string
  /** Совпадение с регулярным выражением; `caseInsensitive` — для фильтров. */
  regex(sql: string, pattern: string, caseInsensitive: boolean): string
  /**
   * Усечение даты: для даты-времени — в поясе `tz`. Пояс передаётся функцией:
   * параметр пояса связывается, только если он нужен (иначе в запросе
   * остался бы параметр без `$n` в тексте).
   */
  dateTrunc(unit: DateUnit, sql: string, temporal: 'date' | 'datetime', tz: () => string): string
  /** Часть даты целым числом: для даты-времени — в поясе `tz`. */
  datePart(part: DatePart, sql: string, temporal: 'date' | 'datetime', tz: () => string): string
  /** Интервал из `n` единиц (SQL-выражение целого числа). */
  interval(unit: IntervalUnit, n: string): string
  /** Дата в поясе из даты-времени. */
  localDate(sql: string, tz: string): string
  percentile(p: number, sql: string): string
  /** Значение входит в массив (параметр-массив). */
  inArray(sql: string, array: string): string
  /** Геометрия в результате — GeoJSON (contracts/query-spec.md). */
  geoJson(sql: string): string
  /** Геометрия из GeoJSON-параметра, SRID 4326. */
  geomFromGeoJson(sql: string): string
  /** Геометрия как география — метрические расстояния, площади, буферы. */
  geography(sql: string): string
  randomOrder(): string
  /** Приведение строки без ошибки: неверное значение — NULL (ошибка раскрыла бы данные). */
  tryCast(sql: string, type: 'date' | 'uuid'): string
  /** Момент ↔ местное время в поясе `tz` (в обе стороны, как AT TIME ZONE). */
  atTimeZone(sql: string, tz: string): string
  /** Усечение местного времени (timestamp без пояса) до единицы. */
  truncLocal(unit: DateUnit, sql: string): string
  /** Массивы пересекаются. */
  overlaps(sql: string, array: string): string
  /** Число элементов массива. */
  cardinality(sql: string): string
  /** Длина строки в символах (маскирование по политике столбцов). */
  charLength(sql: string): string
  /** Число с плавающей точкой — не конечное (NaN, ±бесконечность). */
  notFinite(sql: string): string
  /** Длительность физического столбца в минутах. */
  durationMinutes(column: string): string
  /** Округление до двух значащих цифр (маска чисел): 123 456 → 120 000. */
  roundSignificant(sql: string): string
  /**
   * Барьер оптимизатора после политики строк: условия пользователя не
   * опускаются ниже политики. `null` — диалект барьера не даёт.
   */
  fence(): string | null
}

const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Имена столбцов и алиасы проверены контрактом; кавычки — защита в глубину. */
function quote(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

const PG_INTERVAL_FIELD: Record<IntervalUnit, [string, number]> = {
  year: ['years', 1],
  quarter: ['months', 3],
  month: ['months', 1],
  week: ['weeks', 1],
  day: ['days', 1],
  hour: ['hours', 1],
  minute: ['mins', 1],
}

const PG_DATE_PART: Record<DatePart, string> = {
  year: 'year',
  quarter: 'quarter',
  month: 'month',
  // Неделя и день недели — ISO: понедельник — первый день (ru, tg)
  week: 'week',
  day: 'day',
  dow: 'isodow',
  hour: 'hour',
}

export const postgresDialect: Dialect = {
  name: 'postgres',
  ident: quote,
  table(ref) {
    const parts = ref.split('.')
    if (parts.length !== 2 || !parts.every((part) => SAFE_IDENT.test(part))) {
      throw new Error(`Недопустимое имя таблицы: ${ref}`)
    }
    return parts.map(quote).join('.')
  },
  placeholder: (index) => `$${index}`,
  cast: (sql, type) => `${sql}::${type}`,
  ilike: (sql, pattern) => `${sql} ILIKE ${pattern} ESCAPE '\\'`,
  regex: (sql, pattern, caseInsensitive) => `${sql} ${caseInsensitive ? '~*' : '~'} ${pattern}`,
  dateTrunc(unit, sql, temporal, tz) {
    return temporal === 'date'
      ? `date_trunc('${unit}', ${sql})::date`
      : `date_trunc('${unit}', ${sql}, ${tz()})`
  },
  datePart(part, sql, temporal, tz) {
    const source = temporal === 'date' ? sql : `(${sql} AT TIME ZONE ${tz()})`
    return `extract(${PG_DATE_PART[part]} FROM ${source})::int`
  },
  interval(unit, n) {
    const [field, factor] = PG_INTERVAL_FIELD[unit]
    const amount = factor === 1 ? n : `(${n}) * ${factor}`
    return `make_interval(${field} => ${amount})`
  },
  localDate: (sql, tz) => `(${sql} AT TIME ZONE ${tz})::date`,
  percentile: (p, sql) => `percentile_cont(${p}) WITHIN GROUP (ORDER BY ${sql})`,
  inArray: (sql, array) => `${sql} = ANY(${array})`,
  geoJson: (sql) => `ST_AsGeoJSON(${sql})::json`,
  geomFromGeoJson: (sql) => `ST_SetSRID(ST_GeomFromGeoJSON(${sql}), 4326)`,
  geography: (sql) => `${sql}::geography`,
  randomOrder: () => 'random()',
  tryCast: (sql, type) =>
    `(CASE WHEN pg_input_is_valid(${sql}, '${type}') THEN (${sql})::${type} END)`,
  atTimeZone: (sql, tz) => `(${sql} AT TIME ZONE ${tz})`,
  truncLocal: (unit, sql) => `date_trunc('${unit}', ${sql})`,
  overlaps: (sql, array) => `${sql} && ${array}`,
  cardinality: (sql) => `cardinality(${sql})`,
  charLength: (sql) => `char_length(${sql})`,
  notFinite: (sql) => `${sql}::text IN ('NaN', 'Infinity', '-Infinity')`,
  durationMinutes: (column) => `(extract(epoch FROM ${column}) / 60)::double precision`,
  roundSignificant: (sql) =>
    `round((${sql})::numeric, (1 - floor(log(abs((${sql})::numeric))))::int)`,
  fence: () => 'OFFSET 0',
}

// ─── DuckDB (колоночный tier, ADR-0109) ──────────────────────────────────────

/**
 * Типы SQL компилятора → типы DuckDB. Колоночная копия хранит ссылки (`uuid`)
 * строками: сравнение и группировка канонических идентификаторов совпадают
 * посимвольно, а лишнего приведения на 5 млн строк не происходит.
 */
const DUCKDB_TYPES: Record<string, string> = {
  text: 'VARCHAR',
  bigint: 'BIGINT',
  int: 'INTEGER',
  integer: 'INTEGER',
  numeric: 'DECIMAL(38,12)',
  'double precision': 'DOUBLE',
  float8: 'DOUBLE',
  boolean: 'BOOLEAN',
  date: 'DATE',
  timestamptz: 'TIMESTAMPTZ',
  timestamp: 'TIMESTAMP',
  time: 'TIME',
  uuid: 'VARCHAR',
  json: 'JSON',
  jsonb: 'JSON',
  'text[]': 'VARCHAR[]',
}

/** Единицы `make_interval` Postgres → функции DuckDB `to_*`. */
const DUCKDB_INTERVAL: Record<IntervalUnit, [string, number]> = {
  year: ['to_years', 1],
  quarter: ['to_months', 3],
  month: ['to_months', 1],
  week: ['to_days', 7],
  day: ['to_days', 1],
  hour: ['to_hours', 1],
  minute: ['to_minutes', 1],
}

function duckdbType(type: string): string {
  const name = type.toLowerCase().trim()
  const mapped = DUCKDB_TYPES[name]
  if (mapped) return mapped
  // Массив значений (списки `IN`, множественный выбор) — список DuckDB
  if (name.endsWith('[]')) return `${duckdbType(name.slice(0, -2))}[]`
  throw new UnsupportedByDialectError(`тип ${type}`, 'duckdb')
}

function unsupported(feature: string): never {
  throw new UnsupportedByDialectError(feature, 'duckdb')
}

/**
 * DuckDB поверх Parquet колоночной копии (ADR-0109). Отличия от Postgres, из-за
 * которых нужен отдельный диалект: имена типов, часовой пояс третьим
 * аргументом `date_trunc`, списки вместо массивов, регулярные выражения
 * функцией. Геометрия в колоночной копии не хранится — запрос с ней
 * завершается `UnsupportedByDialectError`, и вызывающий уходит в Postgres.
 */
export const duckdbDialect: Dialect = {
  name: 'duckdb',
  ident: quote,
  table: postgresDialect.table,
  placeholder: (index) => `$${index}`,
  cast: (sql, type) => `CAST(${sql} AS ${duckdbType(type)})`,
  ilike: (sql, pattern) => `${sql} ILIKE ${pattern} ESCAPE '\\'`,
  regex: (sql, pattern, caseInsensitive) =>
    caseInsensitive
      ? `regexp_matches(${sql}, ${pattern}, 'i')`
      : `regexp_matches(${sql}, ${pattern})`,
  dateTrunc(unit, sql, temporal, tz) {
    if (temporal === 'date') return `CAST(date_trunc('${unit}', ${sql}) AS DATE)`
    // Усечение в поясе: момент → местное время → усечение → снова момент
    return `((date_trunc('${unit}', ${sql} AT TIME ZONE ${tz()})) AT TIME ZONE ${tz()})`
  },
  datePart(part, sql, temporal, tz) {
    const source = temporal === 'date' ? sql : `(${sql} AT TIME ZONE ${tz()})`
    return `CAST(extract(${PG_DATE_PART[part]} FROM ${source}) AS INTEGER)`
  },
  interval(unit, n) {
    const [fn, factor] = DUCKDB_INTERVAL[unit]
    const amount = factor === 1 ? n : `(${n}) * ${factor}`
    return `${fn}(CAST(${amount} AS INTEGER))`
  },
  localDate: (sql, tz) => `CAST(${sql} AT TIME ZONE ${tz} AS DATE)`,
  percentile: (p, sql) => `percentile_cont(${p}) WITHIN GROUP (ORDER BY ${sql})`,
  inArray: (sql, array) => `list_contains(${array}, ${sql})`,
  geoJson: () => unsupported('геометрия в результате'),
  geomFromGeoJson: () => unsupported('геометрия из GeoJSON'),
  geography: () => unsupported('метрические расчёты по геометрии'),
  randomOrder: () => 'random()',
  tryCast: (sql, type) => `TRY_CAST(${sql} AS ${duckdbType(type)})`,
  atTimeZone: (sql, tz) => `(${sql} AT TIME ZONE ${tz})`,
  truncLocal: (unit, sql) => `date_trunc('${unit}', ${sql})`,
  overlaps: (sql, array) => `list_has_any(${sql}, ${array})`,
  cardinality: (sql) => `len(${sql})`,
  charLength: (sql) => `length(${sql})`,
  // DuckDB печатает нечисловые значения как `nan`/`inf`: проверяем функциями
  notFinite: (sql) => `(isnan(${sql}) OR isinf(${sql}))`,
  // Длительность колоночная копия хранит уже в минутах (ADR-0109)
  durationMinutes: (column) => `CAST(${column} AS DOUBLE)`,
  // DuckDB не умеет round(DECIMAL, <не константа>) — считаем в DOUBLE
  roundSignificant(sql) {
    const value = `CAST((${sql}) AS DOUBLE)`
    return `round(${value}, CAST((1 - floor(log(abs(${value})))) AS INTEGER))`
  },
  // LIMIT/OFFSET — граница для опускания условий и в DuckDB
  fence: () => 'OFFSET 0',
}
