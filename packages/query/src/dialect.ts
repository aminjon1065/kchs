/**
 * Диалект SQL. Компилятор пишет запрос через эти примитивы; Postgres — сейчас,
 * DuckDB для колоночного tier (06-analytics-engine.md §5) — за тем же интерфейсом.
 */
export type DateUnit = 'year' | 'quarter' | 'month' | 'week' | 'day' | 'hour'
export type DatePart = 'year' | 'quarter' | 'month' | 'week' | 'day' | 'dow' | 'hour'
export type IntervalUnit = 'year' | 'quarter' | 'month' | 'week' | 'day' | 'hour' | 'minute'
/** Типы безопасного приведения (`cast()` и разбор текста фильтра). */
export type CastType = 'date' | 'uuid' | 'timestamptz' | 'double precision' | 'boolean'

export interface Dialect {
  readonly name: 'postgres'
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
  tryCast(sql: string, type: CastType): string
  /** Момент ↔ местное время в поясе `tz` (в обе стороны, как AT TIME ZONE). */
  atTimeZone(sql: string, tz: string): string
  /** Усечение местного времени (timestamp без пояса) до единицы. */
  truncLocal(unit: DateUnit, sql: string): string
  /** Массивы пересекаются. */
  overlaps(sql: string, array: string): string
  /** Число элементов массива. */
  cardinality(sql: string): string
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
}
