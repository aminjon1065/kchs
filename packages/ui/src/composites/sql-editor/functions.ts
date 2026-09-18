import type { SqlEditorFunction } from './types.js'

const fn = (name: string, signature: string): SqlEditorFunction => ({ name, signature })

/**
 * Функции PostgreSQL и PostGIS для подсказок SqlEditor: агрегаты, окна, даты,
 * строки, числа, геометрия — то, что аналитик пишет в запросах к датасетам.
 * Подсказка ничего не разрешает: допустимость функции проверяет сервер (белый
 * список SQL-лаборатории). Экран может передать свой список в `functions`.
 */
export const SQL_EDITOR_FUNCTIONS: readonly SqlEditorFunction[] = [
  // Агрегаты
  fn('count', '(value)'),
  fn('sum', '(value)'),
  fn('avg', '(value)'),
  fn('min', '(value)'),
  fn('max', '(value)'),
  fn('stddev', '(value)'),
  fn('string_agg', '(value, delimiter)'),
  fn('array_agg', '(value)'),
  fn('bool_and', '(value)'),
  fn('bool_or', '(value)'),
  fn('percentile_cont', '(fraction)'),
  fn('percentile_disc', '(fraction)'),
  // Окна
  fn('row_number', '()'),
  fn('rank', '()'),
  fn('dense_rank', '()'),
  fn('ntile', '(buckets)'),
  fn('lag', '(value, offset)'),
  fn('lead', '(value, offset)'),
  fn('first_value', '(value)'),
  fn('last_value', '(value)'),
  // Условия
  fn('coalesce', '(value, …)'),
  fn('nullif', '(value, other)'),
  fn('greatest', '(value, …)'),
  fn('least', '(value, …)'),
  // Числа
  fn('round', '(value, digits)'),
  fn('ceil', '(value)'),
  fn('floor', '(value)'),
  fn('trunc', '(value, digits)'),
  fn('abs', '(value)'),
  fn('power', '(base, exponent)'),
  fn('sqrt', '(value)'),
  // Строки
  fn('lower', '(text)'),
  fn('upper', '(text)'),
  fn('initcap', '(text)'),
  fn('length', '(text)'),
  fn('trim', '(text)'),
  fn('concat', '(value, …)'),
  fn('concat_ws', '(separator, value, …)'),
  fn('substr', '(text, start, count)'),
  fn('left', '(text, count)'),
  fn('right', '(text, count)'),
  fn('replace', '(text, from, to)'),
  fn('split_part', '(text, delimiter, index)'),
  fn('strpos', '(text, substring)'),
  fn('regexp_replace', '(text, pattern, replacement)'),
  fn('to_char', '(value, format)'),
  // Даты и время
  fn('now', '()'),
  fn('date_trunc', '(unit, value)'),
  fn('date_part', '(field, value)'),
  fn('age', '(timestamp)'),
  fn('make_date', '(year, month, day)'),
  fn('to_date', '(text, format)'),
  fn('to_timestamp', '(text, format)'),
  fn('generate_series', '(start, stop, step)'),
  // Геометрия (PostGIS)
  fn('ST_Area', '(geometry)'),
  fn('ST_Length', '(geometry)'),
  fn('ST_Distance', '(a, b)'),
  fn('ST_DWithin', '(a, b, distance)'),
  fn('ST_Intersects', '(a, b)'),
  fn('ST_Within', '(a, b)'),
  fn('ST_Contains', '(a, b)'),
  fn('ST_Buffer', '(geometry, radius)'),
  fn('ST_Centroid', '(geometry)'),
  fn('ST_X', '(point)'),
  fn('ST_Y', '(point)'),
  fn('ST_MakePoint', '(x, y)'),
  fn('ST_SetSRID', '(geometry, srid)'),
  fn('ST_Transform', '(geometry, srid)'),
  fn('ST_Union', '(geometry)'),
  fn('ST_AsText', '(geometry)'),
  fn('ST_AsGeoJSON', '(geometry)'),
]
