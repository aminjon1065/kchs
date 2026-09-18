import { fail } from '../errors.js'

/**
 * Лексические помощники SQL-лаборатории: параметры `{{имя}}`, границы
 * идентификаторов для переписывания и перевод позиций разборщика (байты UTF-8)
 * в индексы строки JavaScript. Правила лексем — как у сканера Postgres
 * (src/backend/parser/scan.l): строки, имена в кавычках, долларовые строки,
 * вложенные комментарии.
 */

/** Путь ошибок сырого SQL в `QueryIssue.path`. */
export const SQL_PATH = ['sql'] as const

/** Длина имени в Postgres: NAMEDATALEN - 1 байт, длиннее — усекается разборщиком. */
const MAX_IDENT_BYTES = 63
/** Параметр `{{имя}}`; липкий (флаг y): проверка в позиции без копирования хвоста строки. */
const PARAM = /\{\{\s*([\p{L}_][\p{L}\p{N}_]*)\s*\}\}/uy
const WHITESPACE = new Set([' ', '\t', '\n', '\r', '\f', '\v'])

/** Параметр `{{имя}}` в тексте запроса. */
export interface Placeholder {
  name: string
  /** Границы `{{…}}` в тексте — индексы строки JavaScript. */
  start: number
  end: number
  /** Номер `$n`, которым параметр заменён на время разбора. */
  marker: number
}

/** Ошибка в сыром SQL с позицией (индекс строки запроса). */
export function sqlFail(message: string, position: number, hint?: string): never {
  return fail(SQL_PATH, message, { position, ...(hint ? { hint } : {}) })
}

function isIdentStart(ch: string | undefined): boolean {
  if (ch === undefined) return false
  return /[A-Za-z_]/.test(ch) || ch.charCodeAt(0) >= 0x80
}

function isIdentCont(ch: string | undefined): boolean {
  if (ch === undefined) return false
  return /[A-Za-z0-9_$]/.test(ch) || ch.charCodeAt(0) >= 0x80
}

/** Конец комментария: строчного `--` (до перевода строки) или блочного (с вложенностью); иначе null. */
function commentEnd(text: string, i: number): number | null {
  if (text[i] === '-' && text[i + 1] === '-') {
    const newline = text.indexOf('\n', i + 2)
    return newline === -1 ? text.length : newline + 1
  }
  if (text[i] === '/' && text[i + 1] === '*') {
    let depth = 1
    let j = i + 2
    while (j < text.length && depth > 0) {
      if (text[j] === '/' && text[j + 1] === '*') {
        depth++
        j += 2
      } else if (text[j] === '*' && text[j + 1] === '/') {
        depth--
        j += 2
      } else {
        j++
      }
    }
    return j
  }
  return null
}

/** Конец строки в кавычках `quote` (удвоение — экранирование; `backslash` — E-строки). */
function quotedEnd(text: string, i: number, quote: string, backslash = false): number {
  let j = i + 1
  while (j < text.length) {
    const ch = text[j]
    if (backslash && ch === '\\') {
      j += 2
      continue
    }
    if (ch === quote) {
      if (text[j + 1] === quote) {
        j += 2
        continue
      }
      return j + 1
    }
    j++
  }
  return text.length
}

/** Долларовая строка `$тег$…$тег$`: конец или null, если здесь её нет. */
function dollarEnd(text: string, i: number): number | null {
  // Тег — как имя, но без `$`: буква или _, затем буквы, цифры, _
  let j = i + 1
  if (text[j] !== '$') {
    if (!isIdentStart(text[j])) return null
    j++
    while (j < text.length && text[j] !== '$' && isIdentCont(text[j])) j++
    if (text[j] !== '$') return null
  }
  const delimiter = text.slice(i, j + 1)
  const close = text.indexOf(delimiter, j + 1)
  return close === -1 ? text.length : close + delimiter.length
}

/**
 * Параметры `{{имя}}` вне строк, имён в кавычках и комментариев заменяются
 * маркерами `$n` той же длины (с пробелами): позиции разборщика совпадают с
 * позициями исходного текста, а каждый маркер разборщик возвращает как ParamRef.
 */
export function extractPlaceholders(sql: string): { text: string; placeholders: Placeholder[] } {
  const placeholders: Placeholder[] = []
  let text = ''
  let copied = 0
  let i = 0
  while (i < sql.length) {
    const ch = sql[i] as string
    const comment = commentEnd(sql, i)
    if (comment !== null) {
      i = comment
      continue
    }
    if (ch === "'") {
      i = quotedEnd(sql, i, "'")
      continue
    }
    if (ch === '"') {
      i = quotedEnd(sql, i, '"')
      continue
    }
    if (ch === '$') {
      const end = dollarEnd(sql, i)
      i = end ?? i + 1
      continue
    }
    if (isIdentStart(ch)) {
      const start = i
      i++
      while (i < sql.length && isIdentCont(sql[i])) i++
      const word = sql.slice(start, i)
      // E'…' — строка с экранированием обратной косой чертой; U&'…', B'…', X'…', N'…' —
      // обычные правила кавычек (их разберёт следующая итерация)
      if ((word === 'E' || word === 'e') && sql[i] === "'") i = quotedEnd(sql, i, "'", true)
      else if ((word === 'U' || word === 'u') && sql[i] === '&') i++
      continue
    }
    if (ch === '{' && sql[i + 1] === '{') {
      PARAM.lastIndex = i
      const match = PARAM.exec(sql)
      if (!match) {
        sqlFail('Параметр записывается как {{имя}}', i, 'Имя — буквы, цифры и подчёркивание')
      }
      const length = match[0].length
      const name = match[1] as string
      // Вплотную к имени или числу маркер `$n` стал бы частью лексемы (`x$1`)
      if (i > 0 && isIdentCont(sql[i - 1])) {
        sqlFail(
          `Параметр {{${name}}} не распознан`,
          i,
          'Отделите параметр пробелами или скобками от соседних слов',
        )
      }
      const marker = placeholders.length + 1
      const replacement = `$${marker}`
      if (replacement.length > length) sqlFail('Слишком много параметров в запросе', i)
      text += sql.slice(copied, i) + replacement.padEnd(length, ' ')
      placeholders.push({ name, start: i, end: i + length, marker })
      i += length
      copied = i
      continue
    }
    i++
  }
  return { text: text + sql.slice(copied), placeholders }
}

/** Пропуск пробелов и комментариев. */
export function skipTrivia(text: string, i: number): number {
  let j = i
  for (;;) {
    if (WHITESPACE.has(text[j] ?? '')) {
      j++
      continue
    }
    const comment = commentEnd(text, j)
    if (comment === null) return j
    j = comment
  }
}

/** Имя в позиции `start`: обычное (приводится к нижнему регистру ASCII) или в кавычках. */
export function readIdentifier(
  text: string,
  start: number,
): { start: number; end: number; value: string } | null {
  const ch = text[start]
  if ((ch === 'U' || ch === 'u') && text[start + 1] === '&') return null
  if (ch === '"') {
    const end = quotedEnd(text, start, '"')
    if (text[end - 1] !== '"' || end - start < 2) return null
    const value = text.slice(start + 1, end - 1).replaceAll('""', '"')
    return { start, end, value: truncateIdent(value) }
  }
  if (!isIdentStart(ch)) return null
  let end = start + 1
  while (end < text.length && isIdentCont(text[end])) end++
  const raw = text.slice(start, end)
  return { start, end, value: truncateIdent(raw.replace(/[A-Z]/g, (c) => c.toLowerCase())) }
}

/** Цепочка имён через точку (`a . "b"`), начиная с `start`; null — если не разобрать. */
export function readIdentifierChain(
  text: string,
  start: number,
  count: number,
): Array<{ start: number; end: number; value: string }> | null {
  const parts: Array<{ start: number; end: number; value: string }> = []
  let i = start
  for (let n = 0; n < count; n++) {
    if (n > 0) {
      i = skipTrivia(text, i)
      if (text[i] !== '.') return null
      i = skipTrivia(text, i + 1)
    }
    const part = readIdentifier(text, i)
    if (!part) return null
    parts.push(part)
    i = part.end
  }
  return parts
}

/** Имя в двойных кавычках (защита от любых символов в названиях и подписях). */
export function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

function utf8Length(text: string): number {
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4
      i++
    } else bytes += 3
  }
  return bytes
}

/** Имя, как его сохранит разборщик Postgres: не длиннее 63 байт (по границе символа). */
export function truncateIdent(name: string): string {
  if (utf8Length(name) <= MAX_IDENT_BYTES) return name
  let out = ''
  let bytes = 0
  for (const ch of name) {
    const size = utf8Length(ch)
    if (bytes + size > MAX_IDENT_BYTES) break
    out += ch
    bytes += size
  }
  return out
}

/** Недопустимые символы: NUL обрывает текст в протоколе Postgres, одиночные суррогаты — не UTF-8. */
export function invalidCharacter(sql: string): number {
  for (let i = 0; i < sql.length; i++) {
    const code = sql.charCodeAt(i)
    if (code === 0) return i
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = sql.charCodeAt(i + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return i
      i++
    } else if (code >= 0xdc00 && code <= 0xdfff) return i
  }
  return -1
}

/**
 * Позиции разборщика → индексы строки. Узлы дерева хранят смещения в байтах
 * UTF-8, ошибка разбора — номер символа (кодовой точки).
 */
export class SourcePositions {
  private readonly byteAt: number[] = []

  constructor(private readonly text: string) {
    let bytes = 0
    for (let i = 0; i < text.length; i++) {
      this.byteAt.push(bytes)
      const code = text.charCodeAt(i)
      if (code < 0x80) bytes += 1
      else if (code < 0x800) bytes += 2
      else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
        // Вторая половина суррогатной пары — не граница символа: то же смещение
        this.byteAt.push(bytes)
        bytes += 4
        i++
      } else bytes += 3
    }
    this.byteAt.push(bytes)
  }

  /** Байтовое смещение → индекс строки (первый индекс с таким или большим смещением). */
  fromByte(offset: number): number {
    let low = 0
    let high = this.byteAt.length - 1
    while (low < high) {
      const mid = (low + high) >> 1
      if ((this.byteAt[mid] as number) < offset) low = mid + 1
      else high = mid
    }
    return low
  }

  /** Номер кодовой точки → индекс строки. */
  fromCodePoint(index: number): number {
    let i = 0
    for (let n = 0; n < index && i < this.text.length; n++) {
      const code = this.text.charCodeAt(i)
      i += code >= 0xd800 && code <= 0xdbff ? 2 : 1
    }
    return i
  }
}
