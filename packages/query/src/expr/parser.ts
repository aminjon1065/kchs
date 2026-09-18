import { ExpressionError } from '../errors.js'
import type { BinaryOp, Expr } from './ast.js'
import { type Token, tokenize } from './lexer.js'

/**
 * Pratt-парсер языка выражений. Приоритеты (от слабого к сильному):
 * `or` < `and` < `not` < сравнения, `like`, `in`, `is null` < `||` < `+ -` <
 * `* / %` < унарный минус. `==` и `<>` — синонимы `=` и `!=`, `&&` и `!` —
 * `and` и `not` (условия правил автоматизации).
 */
const KEYWORDS = new Set([
  'and',
  'or',
  'not',
  'in',
  'like',
  'is',
  'null',
  'true',
  'false',
  'case',
  'when',
  'then',
  'else',
  'end',
])

const BP = {
  or: 10,
  and: 20,
  not: 30,
  compare: 40,
  concat: 45,
  additive: 50,
  multiplicative: 60,
  unary: 70,
} as const

export const MAX_EXPRESSION_LENGTH = 4000
const MAX_DEPTH = 64

export function parseExpression(source: string): Expr {
  if (source.length > MAX_EXPRESSION_LENGTH) {
    throw new ExpressionError(`Выражение длиннее ${MAX_EXPRESSION_LENGTH} символов`, 0)
  }
  if (!source.trim()) throw new ExpressionError('Пустое выражение', 0)
  const parser = new Parser(tokenize(source))
  const expr = parser.expression(0)
  parser.expectEnd()
  return expr
}

function keyword(token: Token): string | null {
  if (token.kind !== 'ident') return null
  const lower = token.text.toLowerCase()
  return KEYWORDS.has(lower) ? lower : null
}

function describe(token: Token): string {
  if (token.kind === 'eof') return 'конец выражения'
  if (token.kind === 'string') return `строка '${token.text}'`
  return `«${token.text}»`
}

class Parser {
  private index = 0
  private depth = 0

  constructor(private readonly tokens: Token[]) {}

  private peek(offset = 0): Token {
    return (this.tokens[this.index + offset] ?? this.tokens[this.tokens.length - 1]) as Token
  }

  private next(): Token {
    const token = this.peek()
    if (token.kind !== 'eof') this.index++
    return token
  }

  expectEnd(): void {
    const token = this.peek()
    if (token.kind !== 'eof') {
      throw new ExpressionError(
        `Лишнее ${describe(token)}`,
        token.pos,
        'Проверьте оператор между частями выражения',
      )
    }
  }

  private expectKind(kind: Token['kind'], what: string): Token {
    const token = this.next()
    if (token.kind !== kind) {
      throw new ExpressionError(`Ожидалось ${what}, а встретилось ${describe(token)}`, token.pos)
    }
    return token
  }

  private expectKeyword(word: string): Token {
    const token = this.next()
    if (keyword(token) !== word) {
      throw new ExpressionError(`Ожидалось «${word}», а встретилось ${describe(token)}`, token.pos)
    }
    return token
  }

  /** Сила связывания токена в инфиксной позиции. */
  private infixPower(token: Token): number {
    if (token.kind === 'op') {
      switch (token.text) {
        case '||':
          return BP.concat
        case '&&':
          return BP.and
        case '+':
        case '-':
          return BP.additive
        case '*':
        case '/':
        case '%':
          return BP.multiplicative
        case '=':
        case '==':
        case '!=':
        case '<>':
        case '<':
        case '<=':
        case '>':
        case '>=':
          return BP.compare
        default:
          return 0
      }
    }
    switch (keyword(token)) {
      case 'or':
        return BP.or
      case 'and':
        return BP.and
      case 'in':
      case 'like':
      case 'is':
        return BP.compare
      case 'not': {
        // `not in` / `not like` в инфиксной позиции
        const after = keyword(this.peek(1))
        return after === 'in' || after === 'like' ? BP.compare : 0
      }
      default:
        return 0
    }
  }

  expression(rbp: number): Expr {
    if (++this.depth > MAX_DEPTH) {
      throw new ExpressionError('Слишком глубокая вложенность выражения', this.peek().pos)
    }
    let left = this.prefix()
    while (rbp < this.infixPower(this.peek())) {
      left = this.infix(left)
    }
    this.depth--
    return left
  }

  private prefix(): Expr {
    const token = this.next()
    switch (token.kind) {
      case 'number': {
        const value = Number(token.text)
        if (!Number.isFinite(value))
          throw new ExpressionError('Число вне допустимого диапазона', token.pos)
        return { kind: 'number', value, pos: token.pos, end: token.end }
      }
      case 'string':
        return { kind: 'string', value: token.text, pos: token.pos, end: token.end }
      case 'param':
        return { kind: 'param', name: token.text, pos: token.pos, end: token.end }
      case 'macro':
        return { kind: 'macro', name: token.text, pos: token.pos, end: token.end }
      case 'quoted':
        return this.fieldFrom(token)
      case 'lparen': {
        const inner = this.expression(0)
        const close = this.expectKind('rparen', '«)»')
        return { ...inner, pos: token.pos, end: close.end }
      }
      case 'op': {
        if (token.text === '-' || token.text === '+') {
          const operand = this.expression(BP.unary)
          return { kind: 'unary', op: token.text, operand, pos: token.pos, end: operand.end }
        }
        if (token.text === '!') {
          const operand = this.expression(BP.not)
          return { kind: 'unary', op: 'not', operand, pos: token.pos, end: operand.end }
        }
        throw new ExpressionError(`Неожиданный оператор «${token.text}»`, token.pos)
      }
      case 'ident': {
        const word = keyword(token)
        if (word === 'true' || word === 'false') {
          return { kind: 'boolean', value: word === 'true', pos: token.pos, end: token.end }
        }
        if (word === 'null') return { kind: 'null', pos: token.pos, end: token.end }
        if (word === 'not') {
          const operand = this.expression(BP.not)
          return { kind: 'unary', op: 'not', operand, pos: token.pos, end: operand.end }
        }
        if (word === 'case') return this.caseExpr(token)
        if (word) {
          throw new ExpressionError(
            `Неожиданное слово «${token.text}»`,
            token.pos,
            'Если это имя поля, возьмите его в двойные кавычки',
          )
        }
        if (this.peek().kind === 'lparen') return this.call(token)
        return this.fieldFrom(token)
      }
      default:
        throw new ExpressionError(`Ожидалось значение, а встретилось ${describe(token)}`, token.pos)
    }
  }

  /** Поле: `name`, `"имя с пробелами"`, `alias.name`, `alias."имя"`. */
  private fieldFrom(first: Token): Expr {
    if (this.peek().kind === 'dot') {
      this.next()
      const second = this.next()
      if (second.kind !== 'ident' && second.kind !== 'quoted') {
        throw new ExpressionError(`После «${first.text}.» ожидается имя поля`, second.pos)
      }
      return {
        kind: 'field',
        qualifier: first.text,
        name: second.text,
        pos: first.pos,
        end: second.end,
      }
    }
    return { kind: 'field', qualifier: null, name: first.text, pos: first.pos, end: first.end }
  }

  private call(nameToken: Token): Expr {
    this.expectKind('lparen', '«(»')
    const args: Expr[] = []
    if (this.peek().kind !== 'rparen') {
      for (;;) {
        args.push(this.expression(0))
        if (this.peek().kind === 'comma') {
          this.next()
          continue
        }
        break
      }
    }
    const close = this.expectKind('rparen', '«)» или «,»')
    return {
      kind: 'call',
      name: nameToken.text.toLowerCase(),
      args,
      pos: nameToken.pos,
      end: close.end,
    }
  }

  /**
   * `case(when c then v, when c2 then v2, else v3)` (контракт) и
   * `case when c then v … else v3 end` (привычная форма SQL).
   */
  private caseExpr(caseToken: Token): Expr {
    const branches: Array<{ when: Expr; result: Expr }> = []
    let otherwise: Expr | null = null
    if (this.peek().kind === 'lparen') {
      this.next()
      for (;;) {
        const head = this.peek()
        if (keyword(head) === 'when') {
          this.next()
          const when = this.expression(0)
          this.expectKeyword('then')
          branches.push({ when, result: this.expression(0) })
        } else if (keyword(head) === 'else') {
          this.next()
          otherwise = this.expression(0)
        } else {
          throw new ExpressionError(
            `Ожидалось «when» или «else», а встретилось ${describe(head)}`,
            head.pos,
          )
        }
        if (this.peek().kind === 'comma') {
          this.next()
          continue
        }
        break
      }
      const close = this.expectKind('rparen', '«)»')
      if (!branches.length)
        throw new ExpressionError('В case нужна хотя бы одна ветка when', caseToken.pos)
      return { kind: 'case', branches, otherwise, pos: caseToken.pos, end: close.end }
    }
    while (keyword(this.peek()) === 'when') {
      this.next()
      const when = this.expression(0)
      this.expectKeyword('then')
      branches.push({ when, result: this.expression(0) })
    }
    if (!branches.length) {
      throw new ExpressionError('После case ожидается «when» или «(»', this.peek().pos)
    }
    if (keyword(this.peek()) === 'else') {
      this.next()
      otherwise = this.expression(0)
    }
    const end = this.expectKeyword('end')
    return { kind: 'case', branches, otherwise, pos: caseToken.pos, end: end.end }
  }

  private infix(left: Expr): Expr {
    const token = this.next()
    if (token.kind === 'op') {
      const op = normalizeOp(token.text)
      const power = this.infixPower(token)
      const right = this.expression(power)
      return { kind: 'binary', op, left, right, opPos: token.pos, pos: left.pos, end: right.end }
    }
    switch (keyword(token)) {
      case 'or':
      case 'and': {
        const op = keyword(token) as 'or' | 'and'
        const right = this.expression(op === 'or' ? BP.or : BP.and)
        return { kind: 'binary', op, left, right, opPos: token.pos, pos: left.pos, end: right.end }
      }
      case 'is': {
        let negated = false
        if (keyword(this.peek()) === 'not') {
          this.next()
          negated = true
        }
        const nullToken = this.expectKeyword('null')
        return { kind: 'isnull', operand: left, negated, pos: left.pos, end: nullToken.end }
      }
      case 'not': {
        const after = this.next()
        if (keyword(after) === 'in') return this.inList(left, true)
        return this.like(left, true)
      }
      case 'in':
        return this.inList(left, false)
      case 'like':
        return this.like(left, false)
      default:
        throw new ExpressionError(`Неожиданное ${describe(token)}`, token.pos)
    }
  }

  private inList(operand: Expr, negated: boolean): Expr {
    this.expectKind('lparen', '«(» после in')
    const list: Expr[] = []
    for (;;) {
      list.push(this.expression(0))
      if (this.peek().kind === 'comma') {
        this.next()
        continue
      }
      break
    }
    const close = this.expectKind('rparen', '«)» или «,»')
    return { kind: 'in', operand, list, negated, pos: operand.pos, end: close.end }
  }

  private like(operand: Expr, negated: boolean): Expr {
    const pattern = this.expression(BP.compare)
    return { kind: 'like', operand, pattern, negated, pos: operand.pos, end: pattern.end }
  }
}

function normalizeOp(text: string): BinaryOp {
  switch (text) {
    case '==':
      return '='
    case '<>':
      return '!='
    case '&&':
      return 'and'
    default:
      return text as BinaryOp
  }
}
