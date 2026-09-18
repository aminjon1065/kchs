/**
 * Лексер PostgreSQL для подсветки параметров и контекста автодополнения.
 *
 * Токенизатор `@codemirror/lang-sql` понимает только ASCII-идентификаторы: слово
 * `Происшествия` для него — цепочка ошибок, а цифры в `Население_2020` — число.
 * Здесь идентификаторы — любые буквы Unicode, как у самого Postgres, а `{{param}}` —
 * отдельный токен. Лексер не строит дерево: он размечает текст, остальное делают
 * контекст автодополнения (`sql-context.ts`) и оверлей подсветки.
 */

export type SqlTokenType =
  /** Идентификатор или ключевое слово без кавычек: `Происшествия`, `select`. */
  | 'word'
  /** Идентификатор в двойных кавычках: `"Дата происшествия"`. */
  | 'quoted'
  /** Строка: `'…'`, `E'…'`, `$$…$$`. */
  | 'string'
  | 'number'
  | 'comment'
  /** Параметр запроса `{{name}}`. */
  | 'param'
  /** Позиционный параметр `$1`. */
  | 'positional'
  | 'dot'
  | 'comma'
  | 'semicolon'
  | 'open'
  | 'close'
  | 'operator'
  | 'other'

export interface SqlToken {
  type: SqlTokenType
  from: number
  to: number
  /**
   * Литерал, комментарий, идентификатор в кавычках или параметр закрыт.
   * Незакрытый токен тянется до конца текста (у параметра — до конца имени).
   */
  closed: boolean
}

const WORD = /[\p{L}_][\p{L}\p{M}\p{N}_$]*/uy
const NUMBER = /(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/y
const PARAM = /\{\{(\s*)([\p{L}\p{N}_]*)(\s*)(\}\})?/uy
const DOLLAR_TAG = /\$([\p{L}_][\p{L}\p{N}_]*)?\$/uy
const POSITIONAL = /\$\d+/y
const OPERATOR_CHARS = '+-*/<>=~!@#%^&|`?:'
const SPACE = /\s/

function matchAt(re: RegExp, text: string, at: number): RegExpExecArray | null {
  re.lastIndex = at
  return re.exec(text)
}

/** Конец строки в одинарных кавычках: `''` внутри — экранированная кавычка. */
function readQuoted(text: string, start: number, quote: string, backslash: boolean) {
  let i = start + 1
  while (i < text.length) {
    const ch = text[i]
    if (backslash && ch === '\\') {
      i += 2
      continue
    }
    if (ch === quote) {
      if (text[i + 1] === quote) {
        i += 2
        continue
      }
      return { to: i + 1, closed: true }
    }
    i += 1
  }
  return { to: text.length, closed: false }
}

/** Блочный комментарий Postgres — с вложенностью. */
function readBlockComment(text: string, start: number) {
  let depth = 1
  let i = start + 2
  while (i < text.length) {
    if (text.startsWith('*/', i)) {
      depth -= 1
      i += 2
      if (depth === 0) return { to: i, closed: true }
    } else if (text.startsWith('/*', i)) {
      depth += 1
      i += 2
    } else {
      i += 1
    }
  }
  return { to: text.length, closed: false }
}

/** Разбирает весь текст запроса в токены; пробелы не выдаются. */
export function lexSql(text: string): SqlToken[] {
  const tokens: SqlToken[] = []
  const push = (type: SqlTokenType, from: number, to: number, closed = true) => {
    tokens.push({ type, from, to, closed })
    return to
  }
  let i = 0
  while (i < text.length) {
    const ch = text[i] as string
    if (SPACE.test(ch)) {
      i += 1
      continue
    }
    if (ch === '-' && text[i + 1] === '-') {
      const end = text.indexOf('\n', i)
      i = push('comment', i, end < 0 ? text.length : end)
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      const { to, closed } = readBlockComment(text, i)
      i = push('comment', i, to, closed)
      continue
    }
    if (ch === "'") {
      const { to, closed } = readQuoted(text, i, "'", false)
      i = push('string', i, to, closed)
      continue
    }
    if (ch === '"') {
      const { to, closed } = readQuoted(text, i, '"', false)
      i = push('quoted', i, to, closed)
      continue
    }
    if (ch === '$') {
      const positional = matchAt(POSITIONAL, text, i)
      if (positional) {
        i = push('positional', i, i + positional[0].length)
        continue
      }
      const tag = matchAt(DOLLAR_TAG, text, i)
      if (tag) {
        const end = text.indexOf(tag[0], i + tag[0].length)
        i = push('string', i, end < 0 ? text.length : end + tag[0].length, end >= 0)
        continue
      }
    }
    if (ch === '{' && text[i + 1] === '{') {
      const [whole, lead = '', name = '', , close] = matchAt(PARAM, text, i) as RegExpExecArray
      // Незакрытый параметр кончается на имени: пробелы после него — уже не параметр
      const to = close ? i + whole.length : i + 2 + lead.length + name.length
      i = push('param', i, to, Boolean(close))
      continue
    }
    const number = /[\d.]/.test(ch) ? matchAt(NUMBER, text, i) : null
    if (number) {
      i = push('number', i, i + number[0].length)
      continue
    }
    const word = matchAt(WORD, text, i)
    if (word) {
      const end = i + word[0].length
      // Префиксы строк: E'…' (с обратной косой чертой), B'…', X'…', N'…'
      if (word[0].length === 1 && text[end] === "'" && /[eEbBxXnN]/.test(word[0])) {
        const { to, closed } = readQuoted(text, end, "'", /[eE]/.test(word[0]))
        i = push('string', i, to, closed)
      } else {
        i = push('word', i, end)
      }
      continue
    }
    if (ch === '.') {
      i = push('dot', i, i + 1)
      continue
    }
    if (ch === ',') {
      i = push('comma', i, i + 1)
      continue
    }
    if (ch === ';') {
      i = push('semicolon', i, i + 1)
      continue
    }
    if (ch === '(' || ch === '[') {
      i = push('open', i, i + 1)
      continue
    }
    if (ch === ')' || ch === ']') {
      i = push('close', i, i + 1)
      continue
    }
    if (OPERATOR_CHARS.includes(ch)) {
      let end = i + 1
      // Цепочка операторов не поглощает начало комментария
      while (
        end < text.length &&
        OPERATOR_CHARS.includes(text[end] as string) &&
        !text.startsWith('--', end) &&
        !text.startsWith('/*', end)
      ) {
        end += 1
      }
      i = push('operator', i, end)
      continue
    }
    const size = (text.codePointAt(i) ?? 0) > 0xffff ? 2 : 1
    i = push('other', i, i + size)
  }
  return tokens
}

/** Идентификатор содержит буквы вне ASCII — его лексер lang-sql не распознаёт. */
export function isUnicodeWord(text: string): boolean {
  return /[^\p{ASCII}]/u.test(text)
}
