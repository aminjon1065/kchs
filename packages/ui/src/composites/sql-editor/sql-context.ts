import { lexSql, type SqlToken } from './sql-lexer.js'

/**
 * Контекст автодополнения в позиции курсора: что сейчас пишет пользователь —
 * имя таблицы после FROM/JOIN, поле через точку (`Происшествия.` или псевдоним
 * `п.`), параметр `{{…}}` или выражение. Разбор — по токенам текущего оператора
 * (между `;`), без дерева: запрос в редакторе чаще всего недописан.
 */

/** Имя из текста запроса: без кавычек Postgres приводит латиницу к строчной. */
export interface SqlName {
  value: string
  quoted: boolean
}

/** Таблица в FROM/JOIN оператора и её псевдоним. */
export interface SqlTableRef {
  name: SqlName
  alias: SqlName | null
}

interface NameSpan {
  /** Заменяемый фрагмент: слово целиком или идентификатор вместе с кавычками. */
  from: number
  to: number
  /** Набранное до курсора — по нему фильтруются подсказки. */
  query: string
  /** Пользователь начал имя с кавычки — вставка тоже в кавычках. */
  quoted: boolean
}

export type SqlCompletionContext =
  | { kind: 'none' }
  /** После имени таблицы в FROM: пишут псевдоним или ключевое слово. */
  | { kind: 'alias' }
  | { kind: 'param'; from: number; to: number; query: string; close: boolean }
  | (NameSpan & { kind: 'table' })
  | (NameSpan & { kind: 'member'; qualifier: SqlName; refs: SqlTableRef[] })
  | (NameSpan & { kind: 'general'; refs: SqlTableRef[] })

const NONE: SqlCompletionContext = { kind: 'none' }

/** Слова, после которых запятая уже не продолжает список таблиц FROM. */
const CLAUSE = new Set(
  'select where group having order limit offset fetch union intersect except window on using join values returning set with by into for'.split(
    ' ',
  ),
)

/** Слова после имени таблицы, которые не могут быть её псевдонимом. */
const NOT_ALIAS = new Set(
  'where join left right inner outer full cross natural on using group order limit offset having union intersect except window fetch for lateral tablesample as select returning with set'.split(
    ' ',
  ),
)

const PARAM_NAME = /^\{\{(\s*)([\p{L}\p{N}_]*)/u

function nameOf(text: string, token: SqlToken | undefined): SqlName | null {
  if (!token) return null
  if (token.type === 'word') return { value: text.slice(token.from, token.to), quoted: false }
  if (token.type !== 'quoted') return null
  const inner = text.slice(token.from + 1, token.closed ? token.to - 1 : token.to)
  return { value: inner.replaceAll('""', '"'), quoted: true }
}

/** Разбор оператора: токены, текст, ключевые слова без учёта регистра. */
class Statement {
  constructor(
    readonly text: string,
    readonly tokens: SqlToken[],
  ) {}

  word(index: number): string | null {
    const token = this.tokens[index]
    return token?.type === 'word' ? this.text.slice(token.from, token.to).toLowerCase() : null
  }

  /** Ближайший значимый токен не правее `index` (комментарии пропускаются). */
  significant(index: number): number {
    let i = index
    while (i >= 0 && this.tokens[i]?.type === 'comment') i -= 1
    return i
  }

  isName(index: number): boolean {
    const type = this.tokens[index]?.type
    return type === 'word' || type === 'quoted'
  }

  /** Индекс начала цепочки `схема.таблица`, заканчивающейся на `index`. */
  chainStart(index: number): number {
    let i = index
    while (this.tokens[i - 1]?.type === 'dot' && this.isName(i - 2)) i -= 2
    return i
  }

  /**
   * Запятая в `index` продолжает список таблиц FROM: слева на той же глубине скобок
   * встречается FROM раньше, чем другое предложение (SELECT, WHERE, JOIN…).
   */
  inFromList(index: number): boolean {
    let depth = 0
    for (let i = index - 1; i >= 0; i -= 1) {
      const type = this.tokens[i]?.type
      if (type === 'close') depth += 1
      else if (type === 'open') {
        if (depth === 0) return false
        depth -= 1
      } else if (depth === 0) {
        const word = this.word(i)
        if (word === 'from') return true
        if (word && CLAUSE.has(word)) return false
      }
    }
    return false
  }

  /** Перед `index` стоит место для имени таблицы: FROM, JOIN или запятая списка FROM. */
  expectsTable(index: number): boolean {
    const word = this.word(index)
    if (word === 'from' || word === 'join') return true
    return this.tokens[index]?.type === 'comma' && this.inFromList(index)
  }

  /** Таблицы оператора: FROM a [AS] x, b y JOIN c ON … — с псевдонимами. */
  tableRefs(): SqlTableRef[] {
    const refs: SqlTableRef[] = []
    for (let i = 0; i < this.tokens.length; i += 1) {
      const word = this.word(i)
      if (word !== 'from' && word !== 'join') continue
      let next = i + 1
      for (;;) {
        const read = this.readTableRef(next)
        if (!read) break
        refs.push(read.ref)
        next = read.next
        if (word !== 'from' || this.tokens[next]?.type !== 'comma') break
        next += 1
      }
    }
    return refs
  }

  private readTableRef(start: number): { ref: SqlTableRef; next: number } | null {
    let i = start
    const lead = this.word(i)
    if (lead === 'only' || lead === 'lateral') i += 1
    if (!this.isName(i) || CLAUSE.has(this.word(i) ?? '')) return null
    // Последнее звено цепочки `схема.таблица` — имя таблицы
    while (this.tokens[i + 1]?.type === 'dot' && this.isName(i + 2)) i += 2
    const name = nameOf(this.text, this.tokens[i]) as SqlName
    i += 1
    let alias: SqlName | null = null
    if (this.word(i) === 'as' && this.isName(i + 1)) {
      alias = nameOf(this.text, this.tokens[i + 1])
      i += 2
    } else if (this.isName(i) && !NOT_ALIAS.has(this.word(i) ?? '')) {
      alias = nameOf(this.text, this.tokens[i])
      i += 1
    }
    return { ref: { name, alias }, next: i }
  }
}

/** Токены оператора, в котором стоит курсор: между ближайшими `;`. */
function statementAt(text: string, pos: number): SqlToken[] {
  const all = lexSql(text)
  let start = 0
  let end = all.length
  for (let i = 0; i < all.length; i += 1) {
    const token = all[i] as SqlToken
    if (token.type !== 'semicolon') continue
    if (token.to <= pos) start = i + 1
    else {
      end = i
      break
    }
  }
  return all.slice(start, end)
}

export function sqlCompletionContext(text: string, pos: number): SqlCompletionContext {
  const statement = new Statement(text, statementAt(text, pos))
  const { tokens } = statement
  // Токен под курсором: курсор внутри него или сразу за последним знаком
  const index = tokens.findIndex((token) => token.from < pos && pos <= token.to)
  const at = tokens[index]
  let span: NameSpan = { from: pos, to: pos, query: '', quoted: false }
  let before = index >= 0 ? index : tokens.findLastIndex((token) => token.to <= pos)

  if (at) {
    const atEnd = pos === at.to
    switch (at.type) {
      case 'comment':
        // Строчный комментарий тянется до конца строки: курсор в его конце — внутри
        if (text.startsWith('--', at.from) || !at.closed || !atEnd) return NONE
        break
      case 'string':
        if (!at.closed || !atEnd) return NONE
        break
      case 'positional':
        return NONE
      case 'param': {
        const [, lead = '', name = ''] = PARAM_NAME.exec(text.slice(at.from, at.to)) ?? []
        const nameFrom = at.from + 2 + lead.length
        const nameTo = nameFrom + name.length
        if (pos < nameFrom || pos > nameTo) return NONE
        return {
          kind: 'param',
          from: nameFrom,
          to: at.closed ? nameTo : pos,
          query: text.slice(nameFrom, pos),
          close: !at.closed,
        }
      }
      case 'quoted':
        if (at.closed && atEnd) break
        span = {
          from: at.from,
          to: at.closed ? at.to : pos,
          query: text.slice(at.from + 1, pos).replaceAll('""', '"'),
          quoted: true,
        }
        before = index - 1
        break
      case 'word':
        span = { from: at.from, to: at.to, query: text.slice(at.from, pos), quoted: false }
        before = index - 1
        break
      default:
        break
    }
  }

  const prev = statement.significant(before)
  const prevToken = tokens[prev]
  if (prevToken?.type === 'dot') {
    const qualifier = nameOf(text, tokens[statement.significant(prev - 1)])
    if (!qualifier) return NONE
    return { kind: 'member', ...span, qualifier, refs: statement.tableRefs() }
  }
  if (statement.word(prev) === 'as') return { kind: 'alias' }
  if (prev >= 0 && statement.expectsTable(prev)) return { kind: 'table', ...span }
  // Сразу после имени таблицы в FROM — место псевдонима, а не поля
  if (statement.isName(prev) && statement.expectsTable(statement.chainStart(prev) - 1)) {
    return { kind: 'alias' }
  }
  return { kind: 'general', ...span, refs: statement.tableRefs() }
}
