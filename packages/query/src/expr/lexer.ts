import { ExpressionError } from '../errors.js'

/**
 * Лексер языка выражений (contracts/query-spec.md §Язык выражений): числа,
 * строки в одинарных кавычках (`''` — кавычка), идентификаторы и `"поля с
 * пробелами"`, параметры `@param:name`, макросы `@me`, `@today`…, операторы.
 */
export type TokenKind =
  | 'number'
  | 'string'
  | 'ident'
  | 'quoted'
  | 'param'
  | 'macro'
  | 'op'
  | 'lparen'
  | 'rparen'
  | 'comma'
  | 'dot'
  | 'eof'

export interface Token {
  kind: TokenKind
  /** Текст токена; для строк и идентификаторов в кавычках — значение без кавычек. */
  text: string
  /** Смещение начала (0-based) и конца в исходном выражении. */
  pos: number
  end: number
}

/** Многосимвольные операторы — раньше односимвольных. */
const OPERATORS = [
  '<=',
  '>=',
  '!=',
  '<>',
  '==',
  '||',
  '&&',
  '=',
  '<',
  '>',
  '+',
  '-',
  '*',
  '/',
  '%',
  '!',
]

const MACROS = new Set(['me', 'my_unit', 'my_units', 'my_territories', 'today', 'now'])

const IDENT_START = /[\p{L}_]/u
const IDENT_PART = /[\p{L}\p{N}_]/u

export function tokenize(source: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < source.length) {
    const ch = source[i] as string
    if (/\s/.test(ch)) {
      i++
      continue
    }
    const start = i

    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(source[i + 1] ?? ''))) {
      const match = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(source.slice(i))
      const text = match?.[0] ?? ch
      i += text.length
      if (IDENT_START.test(source[i] ?? '')) {
        throw new ExpressionError(`Неожиданный символ «${source[i]}» после числа`, i)
      }
      tokens.push({ kind: 'number', text, pos: start, end: i })
      continue
    }

    if (ch === "'") {
      let value = ''
      i++
      for (;;) {
        if (i >= source.length) {
          throw new ExpressionError(
            'Строка не закрыта кавычкой',
            start,
            "Добавьте ' в конце строки",
          )
        }
        const c = source[i] as string
        if (c === "'") {
          if (source[i + 1] === "'") {
            value += "'"
            i += 2
            continue
          }
          i++
          break
        }
        value += c
        i++
      }
      tokens.push({ kind: 'string', text: value, pos: start, end: i })
      continue
    }

    if (ch === '"') {
      let value = ''
      i++
      for (;;) {
        if (i >= source.length) {
          throw new ExpressionError(
            'Имя поля не закрыто кавычкой',
            start,
            'Добавьте " в конце имени',
          )
        }
        const c = source[i] as string
        if (c === '"') {
          if (source[i + 1] === '"') {
            value += '"'
            i += 2
            continue
          }
          i++
          break
        }
        value += c
        i++
      }
      if (!value) throw new ExpressionError('Пустое имя поля в кавычках', start)
      tokens.push({ kind: 'quoted', text: value, pos: start, end: i })
      continue
    }

    if (ch === '@') {
      const match = /^@([A-Za-z_][A-Za-z0-9_]*)(?::([A-Za-z_][A-Za-z0-9_]*))?/.exec(source.slice(i))
      if (!match) throw new ExpressionError('После @ ожидается имя параметра или макроса', start)
      const [text, head, tail] = match
      i += text.length
      if (head === 'param') {
        if (!tail) {
          throw new ExpressionError(
            'Параметр пишется как @param:имя',
            start,
            'Например, @param:period',
          )
        }
        tokens.push({ kind: 'param', text: tail, pos: start, end: i })
      } else if (!tail && MACROS.has(head as string)) {
        tokens.push({ kind: 'macro', text: head as string, pos: start, end: i })
      } else {
        throw new ExpressionError(
          `Неизвестный макрос «${text}»`,
          start,
          'Доступны @me, @my_unit, @my_units, @my_territories, @today, @now, @param:имя',
        )
      }
      continue
    }

    if (IDENT_START.test(ch)) {
      while (i < source.length && IDENT_PART.test(source[i] as string)) i++
      tokens.push({ kind: 'ident', text: source.slice(start, i), pos: start, end: i })
      continue
    }

    if (ch === '(') {
      tokens.push({ kind: 'lparen', text: ch, pos: start, end: ++i })
      continue
    }
    if (ch === ')') {
      tokens.push({ kind: 'rparen', text: ch, pos: start, end: ++i })
      continue
    }
    if (ch === ',') {
      tokens.push({ kind: 'comma', text: ch, pos: start, end: ++i })
      continue
    }
    if (ch === '.') {
      tokens.push({ kind: 'dot', text: ch, pos: start, end: ++i })
      continue
    }

    const op = OPERATORS.find((candidate) => source.startsWith(candidate, i))
    if (op) {
      i += op.length
      tokens.push({ kind: 'op', text: op, pos: start, end: i })
      continue
    }

    throw new ExpressionError(`Неожиданный символ «${ch}»`, start)
  }
  tokens.push({ kind: 'eof', text: '', pos: source.length, end: source.length })
  return tokens
}
