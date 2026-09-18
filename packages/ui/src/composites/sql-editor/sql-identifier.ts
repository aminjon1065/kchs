/**
 * Имена в тексте SQL: когда нужны кавычки и как перевести позицию ошибки Postgres
 * в смещение редактора. Модуль лёгкий и входит в основной бандл: им пользуются и
 * экраны (вставка имени из дерева схемы), и ленивый модуль редактора.
 */

/**
 * Ключевые слова, которые без кавычек не прочитаются как имя: зарезервированные,
 * зарезервированные «кроме функций и типов» и не допускающие роль функции или
 * типа (PostgreSQL, приложение C). Лишние кавычки безвредны, недостающие — ошибка.
 */
const RESERVED = new Set(
  (
    'all analyse analyze and any array as asc asymmetric authorization between bigint binary ' +
    'bit boolean both case cast char character check coalesce collate collation column ' +
    'concurrently constraint create cross current_catalog current_date current_role ' +
    'current_schema current_time current_timestamp current_user dec decimal default deferrable ' +
    'desc distinct do else end except exists extract false fetch float for foreign freeze from ' +
    'full grant greatest group grouping having ilike in initially inner inout int integer ' +
    'intersect interval into is isnull join json json_array json_arrayagg json_exists ' +
    'json_object json_objectagg json_query json_scalar json_serialize json_table json_value ' +
    'lateral leading least left like limit localtime localtimestamp merge_action national ' +
    'natural nchar none normalize not notnull null nullif numeric offset on only or order out ' +
    'outer overlaps overlay placing position precision primary real references returning right ' +
    'row select session_user setof similar smallint some substring symmetric system_user table ' +
    'tablesample then time timestamp to trailing treat trim true union unique user using values ' +
    'varchar variadic verbose when where window with xmlattributes xmlconcat xmlelement ' +
    'xmlexists xmlforest xmlnamespaces xmlparse xmlpi xmlroot xmlserialize xmltable'
  ).split(' '),
)

/**
 * Имя без кавычек, которое Postgres прочтёт как есть: первая — буква любого
 * алфавита или `_`, дальше буквы, цифры, `_`, `$`. Латиница только строчная:
 * заглавную ASCII Postgres приведёт к строчной, а кириллицу в UTF-8 оставит как есть.
 */
const BARE = /^[\p{L}_][\p{L}\p{M}\p{N}_$]*$/u

/**
 * Имя таблицы или поля для текста запроса: как есть, если Postgres прочтёт его
 * так же (`Происшествия`, `incident_date`), иначе в двойных кавычках с удвоением
 * кавычек внутри (`"Дата происшествия"`, `"ID"`, `"order"`).
 */
export function quoteSqlIdentifier(name: string): string {
  const bare = BARE.test(name) && !/[A-Z]/.test(name) && !RESERVED.has(name)
  return bare ? name : `"${name.replaceAll('"', '""')}"`
}

/**
 * Позиция ошибки Postgres → смещение в тексте запроса для `diagnostics` SqlEditor.
 * Postgres и libpg-query считают позицию с 1 и в символах (кодовых точках), а
 * редактор — с 0 и в единицах UTF-16: символы вне BMP (эмодзи в строке) занимают две.
 */
export function sqlPositionToOffset(sql: string, position: number): number {
  let offset = 0
  for (let char = 1; char < position && offset < sql.length; char += 1) {
    offset += (sql.codePointAt(offset) ?? 0) > 0xffff ? 2 : 1
  }
  return Math.min(offset, sql.length)
}
