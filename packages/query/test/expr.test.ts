import type { FieldType } from '@kchs/contracts'
import { describe, expect, it } from 'vitest'
import { tokenize } from '../src/expr/lexer.js'
import {
  compileCondition,
  compileExpression,
  type ExprEnv,
  ExpressionError,
  type ExprValue,
  ParamBinder,
  parseExpression,
  postgresDialect,
  type ReferenceRequest,
  referenceKey,
  type ValueType,
} from '../src/index.js'

const FIELDS: Record<string, [ValueType, FieldType]> = {
  title: ['text', 'text'],
  kind: ['text', 'select'],
  code: ['text', 'identifier'],
  damage: ['number', 'money'],
  victims: ['number', 'integer'],
  ratio: ['number', 'number'],
  occurred_at: ['datetime', 'datetime'],
  reported_on: ['date', 'date'],
  start_time: ['time', 'time'],
  territory_id: ['uuid', 'territory'],
  assignee: ['uuid', 'user'],
  is_confirmed: ['boolean', 'boolean'],
  tags: ['text[]', 'multi_select'],
  geom: ['geometry', 'geometry'],
  meta: ['json', 'json'],
  'имя поля': ['text', 'text'],
  сумма: ['number', 'number'],
}
const REGION: Record<string, [ValueType, FieldType]> = {
  population: ['number', 'integer'],
  name: ['text', 'text'],
}

const NOW_ISO = '2026-09-18T07:30:00.000Z'
const ME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const UNITS = ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2']
const TERRITORIES = ['cccccccc-cccc-4ccc-8ccc-ccccccccccc1']

const PARAMS: Record<string, ExprValue> = {
  p_num: { value: 5, type: 'number' },
  p_text: { value: 'abc', type: 'text' },
  p_date: { value: '2026-01-01', type: 'date' },
  p_dt: { value: '2026-01-01T10:00:00Z', type: 'datetime' },
  p_list: { value: ['a', 'b'], type: 'text', array: true },
  p_untyped: { value: '2026-02-01', type: null },
  p_missing: { value: null, type: 'number' },
  p_bad_date: { value: '01.02.2026', type: 'date' },
}

const MACROS: Record<string, ExprValue> = {
  me: { value: ME, type: 'uuid' },
  my_unit: { value: UNITS[0], type: 'uuid' },
  my_units: { value: UNITS, type: 'uuid', array: true },
  my_territories: { value: TERRITORIES, type: 'uuid', array: true },
  today: { value: '2026-09-18', type: 'date' },
  now: { value: NOW_ISO, type: 'datetime' },
}

const ATTRIBUTES: Record<string, unknown> = { level: 3, region: 'DU', codes: ['DU', 'KH'] }

/** Поле «Вид» связано со справочником типов (lookup_label). */
const KIND_LOOKUP = { datasetId: 'types', keyField: 'code', labelField: 'name' }

interface Options {
  mode?: 'row' | 'aggregate'
  groupKeys?: string[]
  filter?: string
  condition?: boolean
  /** Окружение без справочных подстановок (например, проверка условия правила). */
  noReferences?: boolean
}

function compile(source: string, options: Options = {}) {
  const d = postgresDialect
  const binder = new ParamBinder(d)
  const env: ExprEnv = {
    dialect: d,
    binder,
    mode: options.mode ?? 'row',
    groupKeys: new Set((options.groupKeys ?? []).map((name) => `${d.ident('t')}.${d.ident(name)}`)),
    ...(options.filter ? { aggregateFilter: options.filter } : {}),
    resolveField(qualifier, name, pos) {
      const table = qualifier === null ? FIELDS : qualifier === 'reg' ? REGION : undefined
      const found = table?.[name]
      if (!found) throw new ExpressionError(`Нет поля «${name}»`, pos)
      const relation = qualifier === 'reg' ? 'r' : 't'
      return {
        sql: `${d.ident(relation)}.${d.ident(name)}`,
        type: found[0],
        fieldType: found[1],
        ...(qualifier === null && name === 'kind' ? { lookup: KIND_LOOKUP } : {}),
      }
    },
    resolveParam(name, pos) {
      const value = PARAMS[name]
      if (!value) throw new ExpressionError(`Неизвестный параметр «${name}»`, pos)
      return value
    },
    resolveMacro(name, pos) {
      const value = MACROS[name]
      if (!value) throw new ExpressionError(`Неизвестный макрос «${name}»`, pos)
      return value
    },
    userAttr(key) {
      const value = ATTRIBUTES[key]
      return { value: value ?? null, type: null, ...(Array.isArray(value) ? { array: true } : {}) }
    },
    timezone: () => binder.once('tz', 'Asia/Dushanbe', 'text'),
    now: () => binder.once('now', NOW_ISO, 'timestamptz'),
    ...(options.noReferences
      ? {}
      : {
          reference: (request: ReferenceRequest) =>
            binder.once(`ref:${referenceKey(request)}`, referenceKey(request), 'jsonb'),
        }),
  }
  const compiled = (options.condition ? compileCondition : compileExpression)(source, env)
  return { ...compiled, params: binder.values }
}

const sql = (source: string, options?: Options) => compile(source, options).sql

function failure(source: string, options?: Options): ExpressionError {
  try {
    compile(source, options)
  } catch (error) {
    if (error instanceof ExpressionError) return error
    throw error
  }
  throw new Error(`Нет ошибки: ${source}`)
}

// ─── Лексер ──────────────────────────────────────────────────────────────────

describe('лексер', () => {
  it.each([
    ['42', 'number', '42'],
    ['3.14', 'number', '3.14'],
    ['.5', 'number', '.5'],
    ['1e3', 'number', '1e3'],
    ['2.5E-2', 'number', '2.5E-2'],
    ["'abc'", 'string', 'abc'],
    ["'it''s'", 'string', "it's"],
    ["''", 'string', ''],
    ["'Душанбе'", 'string', 'Душанбе'],
    ['"имя поля"', 'quoted', 'имя поля'],
    ['"a""b"', 'quoted', 'a"b'],
    ['сумма', 'ident', 'сумма'],
    ['_x1', 'ident', '_x1'],
    ['@param:period', 'param', 'period'],
    ['@me', 'macro', 'me'],
    ['@my_unit', 'macro', 'my_unit'],
    ['@my_units', 'macro', 'my_units'],
    ['@my_territories', 'macro', 'my_territories'],
    ['@today', 'macro', 'today'],
    ['@now', 'macro', 'now'],
  ])('%s → %s', (source, kind, text) => {
    const [token] = tokenize(source)
    expect(token).toMatchObject({ kind, text, pos: 0, end: source.length })
  })

  it.each(['<=', '>=', '!=', '<>', '==', '||', '&&', '!', '%', '=', '<', '>', '+', '-', '*', '/'])(
    'оператор %s',
    (op) => {
      expect(tokenize(`a ${op} b`)[1]).toMatchObject({ kind: 'op', text: op, pos: 2 })
    },
  )

  it('позиции токенов и конец выражения', () => {
    const tokens = tokenize('abs(x) + 1')
    expect(tokens.map((token) => [token.kind, token.pos, token.end])).toEqual([
      ['ident', 0, 3],
      ['lparen', 3, 4],
      ['ident', 4, 5],
      ['rparen', 5, 6],
      ['op', 7, 8],
      ['number', 9, 10],
      ['eof', 10, 10],
    ])
  })

  it('точка между алиасом и полем', () => {
    expect(tokenize('reg.name').map((token) => token.kind)).toEqual([
      'ident',
      'dot',
      'ident',
      'eof',
    ])
  })

  it.each([
    ["'abc", 'Строка не закрыта кавычкой', 0],
    ['x = "поле', 'Имя поля не закрыто кавычкой', 4],
    ['""', 'Пустое имя поля в кавычках', 0],
    ['@param', 'Параметр пишется как @param:имя', 0],
    ['1 + @unknown', 'Неизвестный макрос «@unknown»', 4],
    ['@', 'После @ ожидается имя параметра или макроса', 0],
    ['a # b', 'Неожиданный символ «#»', 2],
    ['a; b', 'Неожиданный символ «;»', 1],
    ['$1', 'Неожиданный символ «$»', 0],
    ['x[1]', 'Неожиданный символ «[»', 1],
    ['12abc', 'Неожиданный символ «a» после числа', 2],
  ])('ошибка: %s', (source, message, position) => {
    let error: unknown
    try {
      tokenize(source)
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(ExpressionError)
    expect((error as ExpressionError).message).toBe(message)
    expect((error as ExpressionError).position).toBe(position)
  })
})

// ─── Парсер ──────────────────────────────────────────────────────────────────

describe('парсер', () => {
  it('умножение сильнее сложения', () => {
    expect(parseExpression('1 + 2 * 3')).toMatchObject({
      kind: 'binary',
      op: '+',
      left: { kind: 'number', value: 1 },
      right: { kind: 'binary', op: '*' },
    })
  })

  it('скобки меняют порядок', () => {
    expect(parseExpression('(1 + 2) * 3')).toMatchObject({
      kind: 'binary',
      op: '*',
      left: { kind: 'binary', op: '+', pos: 0, end: 7 },
    })
  })

  it('вычитание левоассоциативно', () => {
    expect(parseExpression('a - b - c')).toMatchObject({
      op: '-',
      left: { op: '-', left: { name: 'a' }, right: { name: 'b' } },
      right: { name: 'c' },
    })
  })

  it('and сильнее or', () => {
    expect(parseExpression('a or b and c')).toMatchObject({
      op: 'or',
      left: { name: 'a' },
      right: { op: 'and' },
    })
  })

  it('not слабее сравнения и сильнее and', () => {
    expect(parseExpression('not a = 1 and b')).toMatchObject({
      op: 'and',
      left: { kind: 'unary', op: 'not', operand: { kind: 'binary', op: '=' } },
      right: { name: 'b' },
    })
  })

  it('унарный минус', () => {
    expect(parseExpression('-x * 2')).toMatchObject({
      op: '*',
      left: { kind: 'unary', op: '-', operand: { name: 'x' } },
    })
  })

  it('== и <> — синонимы = и !=', () => {
    expect(parseExpression('a == 1')).toMatchObject({ op: '=' })
    expect(parseExpression('a <> 1')).toMatchObject({ op: '!=' })
  })

  it('&& и ! — синонимы and и not', () => {
    expect(parseExpression('!a && b')).toMatchObject({
      op: 'and',
      left: { kind: 'unary', op: 'not' },
    })
  })

  it('конкатенация слабее сложения', () => {
    expect(parseExpression('a || b + 1')).toMatchObject({ op: '||', right: { op: '+' } })
  })

  it('in, not in, like, not like, is null', () => {
    expect(parseExpression('x in (1, 2)')).toMatchObject({
      kind: 'in',
      negated: false,
      list: [{}, {}],
    })
    expect(parseExpression('x not in (1)')).toMatchObject({ kind: 'in', negated: true })
    expect(parseExpression("x like 'a%'")).toMatchObject({ kind: 'like', negated: false })
    expect(parseExpression("x not like 'a%'")).toMatchObject({ kind: 'like', negated: true })
    expect(parseExpression('x is null')).toMatchObject({ kind: 'isnull', negated: false })
    expect(parseExpression('x is not null')).toMatchObject({ kind: 'isnull', negated: true })
  })

  it('ключевые слова без учёта регистра', () => {
    expect(parseExpression('A AND NOT B OR C IS NULL')).toMatchObject({ op: 'or' })
    expect(parseExpression('TRUE')).toMatchObject({ kind: 'boolean', value: true })
    expect(parseExpression('Null')).toMatchObject({ kind: 'null' })
  })

  it('вызовы функций: без аргументов, вложенные, имя в нижнем регистре', () => {
    expect(parseExpression('NOW()')).toMatchObject({ kind: 'call', name: 'now', args: [] })
    expect(parseExpression('upper(trim(x))')).toMatchObject({
      name: 'upper',
      args: [{ kind: 'call', name: 'trim' }],
    })
    expect(parseExpression('round(x, 2)')).toMatchObject({ args: [{}, { value: 2 }] })
  })

  it('поля с алиасом и в кавычках', () => {
    expect(parseExpression('reg.population')).toMatchObject({
      kind: 'field',
      qualifier: 'reg',
      name: 'population',
    })
    expect(parseExpression('reg."имя"')).toMatchObject({ qualifier: 'reg', name: 'имя' })
    expect(parseExpression('"и или"')).toMatchObject({ qualifier: null, name: 'и или' })
  })

  it('case в двух формах', () => {
    const contract = parseExpression("case(when x > 1 then 'a', when x > 0 then 'b', else 'c')")
    const sqlLike = parseExpression("case when x > 1 then 'a' when x > 0 then 'b' else 'c' end")
    expect(contract).toMatchObject({ kind: 'case', branches: [{}, {}], otherwise: { value: 'c' } })
    expect(sqlLike).toMatchObject({ kind: 'case', branches: [{}, {}], otherwise: { value: 'c' } })
  })

  it('позиции узлов', () => {
    expect(parseExpression('abs(x) + 10')).toMatchObject({
      pos: 0,
      end: 11,
      left: { pos: 0, end: 6 },
      right: { pos: 9, end: 11 },
      opPos: 7,
    })
  })

  it.each([
    ['1 +', 'Ожидалось значение, а встретилось конец выражения', 3],
    ['(1 + 2', 'Ожидалось «)», а встретилось конец выражения', 6],
    ['1 2', 'Лишнее «2»', 2],
    ['and x', 'Неожиданное слово «and»', 0],
    ['x = case', 'После case ожидается «when» или «(»', 8],
    ['case when x then 1', 'Ожидалось «end», а встретилось конец выражения', 18],
    ['case()', 'Ожидалось «when» или «else», а встретилось «)»', 5],
    ['x in 1', 'Ожидалось «(» после in, а встретилось «1»', 5],
    ['x is 5', 'Ожидалось «null», а встретилось «5»', 5],
    ['f(1,)', 'Ожидалось значение, а встретилось «)»', 4],
    ['reg.', 'После «reg.» ожидается имя поля', 4],
    ['* 5', 'Неожиданный оператор «*»', 0],
    ['   ', 'Пустое выражение', 0],
    ['f(1 2)', 'Ожидалось «)» или «,», а встретилось «2»', 4],
    ['case when x 1 end', 'Ожидалось «then», а встретилось «1»', 12],
  ])('ошибка: %s', (source, message, position) => {
    let error: unknown
    try {
      parseExpression(source)
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(ExpressionError)
    expect((error as ExpressionError).message).toBe(message)
    expect((error as ExpressionError).position).toBe(position)
  })

  it('ключевое слово как имя поля — подсказка про кавычки', () => {
    let error: unknown
    try {
      parseExpression('end + 1')
    } catch (caught) {
      error = caught
    }
    expect((error as ExpressionError).hint).toBe(
      'Если это имя поля, возьмите его в двойные кавычки',
    )
    expect(parseExpression('"end" + 1')).toMatchObject({ left: { kind: 'field', name: 'end' } })
  })

  it('слишком глубокая вложенность', () => {
    const source = `${'('.repeat(70)}1${')'.repeat(70)}`
    expect(() => parseExpression(source)).toThrow('Слишком глубокая вложенность выражения')
  })

  it('слишком длинное выражение', () => {
    expect(() => parseExpression(`x + ${'1'.repeat(4000)}`)).toThrow(
      'Выражение длиннее 4000 символов',
    )
  })
})

// ─── Типы и SQL ──────────────────────────────────────────────────────────────

type SqlCase = [source: string, sql: string, type: ValueType, params?: unknown[]]

function checkCases(cases: SqlCase[], options?: Options) {
  it.each(cases)('%s', (source, expected, type, params) => {
    const compiled = compile(source, options)
    expect(compiled.sql).toBe(expected)
    expect(compiled.type).toBe(type)
    if (params) expect(compiled.params).toEqual(params)
    // Каждый связанный параметр упомянут в SQL, лишних номеров нет
    const used = [
      ...new Set([...compiled.sql.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]))),
    ]
    expect(used.sort((a, b) => a - b)).toEqual(compiled.params.map((_, index) => index + 1))
  })
}

describe('арифметика', () => {
  checkCases([
    ['damage + 1', '("t"."damage" + 1)', 'number', []],
    ['damage - victims', '("t"."damage" - "t"."victims")', 'number'],
    ['damage * 2.5', '("t"."damage" * 2.5)', 'number'],
    ['damage * -2', '("t"."damage" * -2)', 'number'],
    ['-(1 + 2)', '(-(1 + 2))', 'number'],
    [
      'damage / victims',
      '("t"."damage"::double precision / NULLIF("t"."victims"::double precision, 0))',
      'number',
    ],
    ['damage % 7', 'mod("t"."damage"::numeric, NULLIF(7::numeric, 0))::double precision', 'number'],
    ['-damage', '(-"t"."damage")', 'number'],
    ['+damage', '"t"."damage"', 'number'],
    ['null + 1', '(NULL::double precision + 1)', 'number'],
    ['1 + 2 * 3', '(1 + (2 * 3))', 'number'],
    ['(1 + 2) * 3', '((1 + 2) * 3)', 'number'],
    ['1e3 + 0.5', '(1000 + 0.5)', 'number'],
    ['сумма * 2', '("t"."сумма" * 2)', 'number'],
    ['"имя поля" || \'!\'', '("t"."имя поля" || $1::text)', 'text', ['!']],
    [
      'reg.population / 1000',
      '("r"."population"::double precision / NULLIF(1000::double precision, 0))',
      'number',
    ],
  ])

  it('тип поля переносится из ссылки', () => {
    expect(compile('damage').fieldType).toBe('money')
    expect(compile('damage + 1').fieldType).toBeUndefined()
  })

  it.each([
    ['title + 1', 'Оператор «+» применим только к числам, а получено: строка', 0],
    ['1 * is_confirmed', 'Оператор «*» применим только к числам, а получено: логическое', 4],
    ['occurred_at + 1', 'Оператор «+» применим только к числам, а получено: дата и время', 12],
    ['reported_on - reported_on', 'Оператор «-» применим только к числам, а получено: дата', 12],
    ['-title', 'Ожидалось: число, а получено: строка', 1],
  ])('ошибка: %s', (source, message, position) => {
    const error = failure(source)
    expect(error.message).toBe(message)
    expect(error.position).toBe(position)
  })

  it('для дат — подсказка про date_add', () => {
    expect(failure('occurred_at + 1').hint).toBe('Для дат используйте date_add() и date_diff()')
  })
})

describe('сравнения', () => {
  checkCases([
    ['damage > 100', '("t"."damage" > 100)', 'boolean'],
    ["title = 'x'", '("t"."title" = $1::text)', 'boolean', ['x']],
    ["title != 'x'", '("t"."title" <> $1::text)', 'boolean'],
    ["title <> 'x'", '("t"."title" <> $1::text)', 'boolean'],
    ["title == 'x'", '("t"."title" = $1::text)', 'boolean'],
    ['victims <= 3', '("t"."victims" <= 3)', 'boolean'],
    ['ratio >= 0.5', '("t"."ratio" >= 0.5)', 'boolean'],
    [
      "occurred_at >= '2026-01-01'",
      '("t"."occurred_at" >= ($1::timestamp AT TIME ZONE $2::text))',
      'boolean',
      ['2026-01-01', 'Asia/Dushanbe'],
    ],
    [
      "occurred_at < '2026-01-01T10:00'",
      '("t"."occurred_at" < ($1::timestamp AT TIME ZONE $2::text))',
      'boolean',
      ['2026-01-01T10:00', 'Asia/Dushanbe'],
    ],
    [
      "occurred_at > '2026-01-01T10:00:00Z'",
      '("t"."occurred_at" > $1::timestamptz)',
      'boolean',
      ['2026-01-01T10:00:00Z'],
    ],
    [
      "occurred_at > '2026-01-01T10:00:00+05:00'",
      '("t"."occurred_at" > $1::timestamptz)',
      'boolean',
    ],
    ["reported_on = '2026-02-28'", '("t"."reported_on" = $1::date)', 'boolean', ['2026-02-28']],
    [
      'reported_on < occurred_at',
      '(("t"."reported_on"::timestamp AT TIME ZONE $1::text) < "t"."occurred_at")',
      'boolean',
    ],
    [
      "territory_id = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1'",
      '("t"."territory_id" = $1::uuid)',
      'boolean',
    ],
    ['is_confirmed = true', '("t"."is_confirmed" = TRUE)', 'boolean'],
    ['is_confirmed = false', '("t"."is_confirmed" = FALSE)', 'boolean'],
    ["start_time > '09:00'", '("t"."start_time" > $1::time)', 'boolean', ['09:00']],
    ['geom = geom', '("t"."geom" = "t"."geom")', 'boolean'],
    ['1 = 1', '(1 = 1)', 'boolean'],
    ["'b' > title", '($1::text > "t"."title")', 'boolean'],
    ['title = null', '("t"."title" = NULL::text)', 'boolean'],
  ])

  it.each([
    ['title = 1', 'Нельзя сравнить «строка» и «число»', 6],
    ['geom > geom', 'Значения типа «геометрия» нельзя сравнивать на больше/меньше', 5],
    ["tags = 'x'", 'Нельзя сравнить «список» и «строка»', 5],
    ["territory_id = 'abc'", '«abc» — не идентификатор', 15],
    ["reported_on = '2026-02-30'", '«2026-02-30» — не дата', 14],
    ["reported_on = '01.02.2026'", '«01.02.2026» — не дата', 14],
    ["occurred_at > 'вчера'", '«вчера» — не дата и время', 14],
    ["start_time > 'noon'", '«noon» — не время', 13],
    ['is_confirmed > 1', 'Нельзя сравнить «логическое» и «число»', 13],
    ['meta < meta', 'Значения типа «JSON» нельзя сравнивать на больше/меньше', 5],
  ])('ошибка: %s', (source, message, position) => {
    const error = failure(source)
    expect(error.message).toBe(message)
    expect(error.position).toBe(position)
  })

  it('подсказка формата даты', () => {
    expect(failure("reported_on = '01.02.2026'").hint).toBe('Дата пишется как ГГГГ-ММ-ДД')
  })
})

describe('логика', () => {
  checkCases([
    ['damage > 1 and victims > 0', '(("t"."damage" > 1) AND ("t"."victims" > 0))', 'boolean'],
    ['is_confirmed or victims > 0', '("t"."is_confirmed" OR ("t"."victims" > 0))', 'boolean'],
    ['not is_confirmed', '(NOT "t"."is_confirmed")', 'boolean'],
    ['!is_confirmed', '(NOT "t"."is_confirmed")', 'boolean'],
    ['is_confirmed && damage > 0', '("t"."is_confirmed" AND ("t"."damage" > 0))', 'boolean'],
    [
      'damage > 1 AND NOT is_confirmed OR victims = 0',
      '((("t"."damage" > 1) AND (NOT "t"."is_confirmed")) OR ("t"."victims" = 0))',
      'boolean',
    ],
    ['true and null', '(TRUE AND NULL::boolean)', 'boolean'],
  ])

  it.each([
    ['damage and true', 'Ожидалось: логическое значение, а получено: число', 0],
    ['true or title', 'Ожидалось: логическое значение, а получено: строка', 8],
    ['not damage', 'Ожидалось: логическое значение, а получено: число', 4],
  ])('ошибка: %s', (source, message, position) => {
    const error = failure(source)
    expect(error.message).toBe(message)
    expect(error.position).toBe(position)
  })
})

describe('in, like, is null', () => {
  checkCases([
    [
      "kind in ('fire', 'flood')",
      '("t"."kind" IN ($1::text, $2::text))',
      'boolean',
      ['fire', 'flood'],
    ],
    ["kind not in ('fire')", '("t"."kind" NOT IN ($1::text))', 'boolean'],
    ['victims in (1, 2, 3)', '("t"."victims" IN (1, 2, 3))', 'boolean'],
    ['kind in (@param:p_list)', '("t"."kind" = ANY($1::text[]))', 'boolean', [['a', 'b']]],
    ['kind not in (@param:p_list)', '(NOT ("t"."kind" = ANY($1::text[])))', 'boolean'],
    ['assignee in (@my_units)', '("t"."assignee" = ANY($1::uuid[]))', 'boolean', [UNITS]],
    [
      'territory_id in (@my_territories)',
      '("t"."territory_id" = ANY($1::uuid[]))',
      'boolean',
      [TERRITORIES],
    ],
    [
      "reported_on in ('2026-01-01', '2026-01-02')",
      '("t"."reported_on" IN ($1::date, $2::date))',
      'boolean',
    ],
    ["title like 'Пож%'", '("t"."title" LIKE $1::text)', 'boolean', ['Пож%']],
    ["title not like '%x'", '("t"."title" NOT LIKE $1::text)', 'boolean'],
    ['title is null', '("t"."title" IS NULL)', 'boolean'],
    ['title is not null', '("t"."title" IS NOT NULL)', 'boolean'],
    ['geom is null', '("t"."geom" IS NULL)', 'boolean'],
    ["kind in (user_attr('codes'))", '("t"."kind" = ANY($1::text[]))', 'boolean', [['DU', 'KH']]],
  ])

  it.each([
    ["victims in ('a')", 'Ожидалось: число, а получено: строка', 12],
    [
      "kind in (@param:p_list, 'x')",
      'Список-параметр должен быть единственным элементом in (…)',
      9,
    ],
    ["damage like 'x'", 'Ожидалось: строка, а получено: число', 0],
    ['title like 1', 'Ожидалось: шаблон-строка, а получено: число', 11],
    ['@my_units', 'Список значений допустим только внутри in (…)', 0],
    ['@my_units is null', 'Список значений допустим только внутри in (…)', 0],
    ["victims in (1, 'x')", 'Ожидалось: число, а получено: строка', 15],
  ])('ошибка: %s', (source, message, position) => {
    const error = failure(source)
    expect(error.message).toBe(message)
    expect(error.position).toBe(position)
  })
})

describe('строки', () => {
  checkCases([
    ["title || ' — ' || kind", '(("t"."title" || $1::text) || "t"."kind")', 'text', [' — ']],
    ['title || victims', '("t"."title" || "t"."victims"::text)', 'text'],
    ['lower(title)', 'lower("t"."title")', 'text'],
    ['UPPER(title)', 'upper("t"."title")', 'text'],
    ['trim(title)', 'trim("t"."title")', 'text'],
    ['length(title)', 'char_length("t"."title")', 'number'],
    ['substr(title, 1, 3)', 'substr("t"."title", (1)::int, greatest((3)::int, 0))', 'text'],
    ['substr(title, 2)', 'substr("t"."title", (2)::int)', 'text'],
    ["replace(title, 'a', 'b')", 'replace("t"."title", $1::text, $2::text)', 'text', ['a', 'b']],
    ["concat(title, ' ', victims)", 'concat("t"."title", $1::text, "t"."victims"::text)', 'text'],
    ["split_part(code, '-', 2)", 'split_part("t"."code", $1::text, NULLIF((2)::int, 0))', 'text'],
    ["regex_match(title, '^П')", '("t"."title" ~ $1::text)', 'boolean', ['^П']],
    ["regex_extract(title, '\\d+')", 'substring("t"."title" FROM $1::text)', 'text', ['\\d+']],
    ["starts_with(title, 'П')", 'starts_with("t"."title", $1::text)', 'boolean'],
    ["contains(title, 'пож')", '(strpos("t"."title", $1::text) > 0)', 'boolean'],
    ["'it''s'", '$1::text', 'text', ["it's"]],
  ])

  it('строковый литерал не попадает в текст SQL', () => {
    const compiled = compile("title = 'x''; DROP TABLE t; --'")
    expect(compiled.sql).toBe('("t"."title" = $1::text)')
    expect(compiled.params).toEqual(["x'; DROP TABLE t; --"])
  })

  it.each([
    ['title || occurred_at', 'Ожидалось: строка или число, а получено: дата и время', 9],
    ['upper(victims)', 'Ожидалось: строка, а получено: число', 6],
    ['length(is_confirmed)', 'Ожидалось: строка, а получено: логическое', 7],
    ['concat(title, geom)', 'Ожидалось: строка или число, а получено: геометрия', 14],
    ['substr(title)', 'Функция substr() принимает аргументов: 2–3, а передано: 1', 0],
    ["replace(title, 'a')", 'Функция replace() принимает аргументов: 3, а передано: 2', 0],
    ["split_part(code, '-', 'x')", 'Ожидалось: число, а получено: строка', 22],
    ['concat()', 'Функция concat() принимает аргументов: не меньше 1, а передано: 0', 0],
  ])('ошибка: %s', (source, message, position) => {
    const error = failure(source)
    expect(error.message).toBe(message)
    expect(error.position).toBe(position)
  })

  it('подсказка format_date при склейке даты', () => {
    expect(failure('title || occurred_at').hint).toBe('Для дат используйте format_date()')
  })
})

describe('числовые функции', () => {
  checkCases([
    ['abs(damage)', 'abs("t"."damage")', 'number'],
    ['floor(ratio)', 'floor("t"."ratio")', 'number'],
    ['ceil(ratio)', 'ceil("t"."ratio")', 'number'],
    ['ceiling(ratio)', 'ceil("t"."ratio")', 'number'],
    ['round(damage)', 'round("t"."damage")', 'number'],
    ['round(damage, 2)', 'round("t"."damage"::numeric, 2)::double precision', 'number'],
    ['round(damage, -3)', 'round("t"."damage"::numeric, -3)::double precision', 'number'],
    ['coalesce(damage, 0)', 'coalesce("t"."damage", 0)', 'number'],
    ["coalesce(title, 'нет')", 'coalesce("t"."title", $1::text)', 'text', ['нет']],
    ["coalesce(reported_on, '2026-01-01')", 'coalesce("t"."reported_on", $1::date)', 'date'],
    ["coalesce('a', 'b')", 'coalesce($1::text, $2::text)', 'text'],
    [
      'coalesce(reported_on, occurred_at)',
      'coalesce(("t"."reported_on"::timestamp AT TIME ZONE $1::text), "t"."occurred_at")',
      'datetime',
    ],
    ['greatest(damage, victims, 0)', 'greatest("t"."damage", "t"."victims", 0)', 'number'],
    ['least(reported_on, @today)', 'least("t"."reported_on", $1::date)', 'date'],
    ['nullif(victims, 0)', 'nullif("t"."victims", 0)', 'number'],
    [
      'safe_div(damage, victims)',
      '("t"."damage"::double precision / NULLIF("t"."victims"::double precision, 0))',
      'number',
    ],
  ])

  it.each([
    ["abs('x')", 'Ожидалось: число, а получено: строка', 4],
    ['abs(1, 2)', 'Функция abs() принимает аргументов: 1, а передано: 2', 0],
    ['round(damage, 20)', 'число знаков: целое число от −10 до 12', 14],
    ['round(damage, victims)', 'число знаков: целое число от −10 до 12', 14],
    ['round(damage, 1.5)', 'число знаков: целое число от −10 до 12', 14],
    ["coalesce(damage, 'x')", 'У значений в аргументы coalesce() разные типы', 17],
    ['coalesce(damage, title)', 'У значений в аргументы coalesce() разные типы', 17],
    ['greatest(geom, geom)', 'Ожидалось: сравнимые значения, а получено: геометрия', 9],
    ["nullif(victims, 'x')", 'Нельзя сравнить «число» и «строка»', 0],
    ['safe_div(title, 1)', 'Ожидалось: число, а получено: строка', 9],
    ['floor()', 'Функция floor() принимает аргументов: 1, а передано: 0', 0],
  ])('ошибка: %s', (source, message, position) => {
    const error = failure(source)
    expect(error.message).toBe(message)
    expect(error.position).toBe(position)
  })
})

describe('даты', () => {
  checkCases([
    ['now()', '$1::timestamptz', 'datetime', [NOW_ISO]],
    [
      'today()',
      '($1::timestamptz AT TIME ZONE $2::text)::date',
      'date',
      [NOW_ISO, 'Asia/Dushanbe'],
    ],
    ['date(occurred_at)', '("t"."occurred_at" AT TIME ZONE $1::text)::date', 'date'],
    ["date('2026-03-01')", '$1::date', 'date', ['2026-03-01']],
    ['date(reported_on)', '"t"."reported_on"', 'date'],
    [
      'date(title)',
      `(CASE WHEN pg_input_is_valid("t"."title", 'date') THEN ("t"."title")::date END)`,
      'date',
    ],
    [
      "date_trunc('month', occurred_at)",
      `date_trunc('month', "t"."occurred_at", $1::text)`,
      'datetime',
    ],
    ["date_trunc('year', reported_on)", `date_trunc('year', "t"."reported_on")::date`, 'date'],
    ["date_trunc('WEEK', reported_on)", `date_trunc('week', "t"."reported_on")::date`, 'date'],
    [
      "date_add(reported_on, 7, 'day')",
      '("t"."reported_on" + make_interval(days => (7)::int))::date',
      'date',
    ],
    [
      "date_add(occurred_at, 2, 'hour')",
      '("t"."occurred_at" + make_interval(hours => (2)::int))',
      'datetime',
    ],
    [
      "date_add(occurred_at, -30, 'minute')",
      '("t"."occurred_at" + make_interval(mins => (-30)::int))',
      'datetime',
    ],
    [
      "date_add(occurred_at, 1, 'quarter')",
      '("t"."occurred_at" + make_interval(months => ((1)::int) * 3))',
      'datetime',
    ],
    [
      "date_add(reported_on, victims, 'week')",
      '("t"."reported_on" + make_interval(weeks => ("t"."victims")::int))::date',
      'date',
    ],
    [
      "date_diff(reported_on, date('2026-12-31'), 'day')",
      '($1::date - "t"."reported_on")',
      'number',
    ],
    [
      "date_diff(occurred_at, now(), 'hour')",
      'trunc(extract(epoch FROM ($1::timestamptz - "t"."occurred_at")) / 3600)::int',
      'number',
    ],
    [
      "date_diff(reported_on, today(), 'month')",
      '(extract(year FROM age(($1::timestamptz AT TIME ZONE $2::text)::date, "t"."reported_on")) * 12 + extract(month FROM age(($1::timestamptz AT TIME ZONE $2::text)::date, "t"."reported_on")))::int',
      'number',
    ],
    [
      "date_diff(reported_on, occurred_at, 'day')",
      'trunc(extract(epoch FROM ("t"."occurred_at" - ("t"."reported_on"::timestamp AT TIME ZONE $1::text))) / 86400)::int',
      'number',
    ],
    [
      'year(occurred_at)',
      'extract(year FROM ("t"."occurred_at" AT TIME ZONE $1::text))::int',
      'number',
    ],
    ['quarter(reported_on)', 'extract(quarter FROM "t"."reported_on")::int', 'number'],
    ['month(reported_on)', 'extract(month FROM "t"."reported_on")::int', 'number'],
    ['week(reported_on)', 'extract(week FROM "t"."reported_on")::int', 'number'],
    ['day(reported_on)', 'extract(day FROM "t"."reported_on")::int', 'number'],
    ['dow(reported_on)', 'extract(isodow FROM "t"."reported_on")::int', 'number'],
    [
      'hour(occurred_at)',
      'extract(hour FROM ("t"."occurred_at" AT TIME ZONE $1::text))::int',
      'number',
    ],
    ["format_date(reported_on, 'DD.MM.YYYY')", 'to_char("t"."reported_on", $1::text)', 'text'],
    [
      "format_date(occurred_at, 'HH24:MI')",
      'to_char(("t"."occurred_at" AT TIME ZONE $1::text), $2::text)',
      'text',
      ['Asia/Dushanbe', 'HH24:MI'],
    ],
  ])

  it.each([
    ['date(damage)', 'Ожидалось: дата, дата и время или строка, а получено: число', 5],
    ["date_trunc('hour', reported_on)", 'Дату нельзя усечь до часа', 19],
    ["date_trunc('decade', occurred_at)", 'Единица — строка из списка', 11],
    ['date_trunc(kind, occurred_at)', 'Единица — строка из списка', 11],
    ["date_add(reported_on, 1, 'hour')", 'К дате прибавляются дни и больше', 25],
    ["date_add(title, 1, 'day')", 'Ожидалось: дата или дата и время, а получено: строка', 9],
    ["date_add(reported_on, 'x', 'day')", 'Ожидалось: число, а получено: строка', 22],
    [
      "date_diff(reported_on, '2026-12-31', 'day')",
      'Ожидалось: дата или дата и время, а получено: строка',
      23,
    ],
    ['hour(reported_on)', 'У даты нет часа', 5],
    ['year(title)', 'Ожидалось: дата или дата и время, а получено: строка', 5],
    ["date('2026-13-01')", '«2026-13-01» — не дата', 5],
    [
      'working_days_between(reported_on, reported_on)',
      'Функция working_days_between() пока недоступна в запросах к данным',
      0,
    ],
    [
      'add_working_days(reported_on, 3)',
      'Функция add_working_days() пока недоступна в запросах к данным',
      0,
    ],
    ['now(1)', 'Функция now() принимает аргументов: 0, а передано: 1', 0],
  ])('ошибка: %s', (source, message, position) => {
    const error = failure(source)
    expect(error.message).toBe(message)
    expect(error.position).toBe(position)
  })

  it('подсказки: единицы и приведение строки к дате', () => {
    expect(failure("date_trunc('decade', occurred_at)").hint).toBe(
      "Допустимо: 'year', 'quarter', 'month', 'week', 'day', 'hour'",
    )
    expect(failure("date_diff(reported_on, '2026-12-31', 'day')").hint).toBe(
      "Строку можно превратить в дату: date('2026-01-01')",
    )
  })
})

describe('условия', () => {
  checkCases([
    [
      "if(damage > 0, 'да', 'нет')",
      '(CASE WHEN ("t"."damage" > 0) THEN $1::text ELSE $2::text END)',
      'text',
      ['да', 'нет'],
    ],
    [
      'if(victims > 0, damage, null)',
      '(CASE WHEN ("t"."victims" > 0) THEN "t"."damage" ELSE NULL::double precision END)',
      'number',
    ],
    [
      "case when damage > 100 then 'big' else 'small' end",
      '(CASE WHEN ("t"."damage" > 100) THEN $1::text ELSE $2::text END)',
      'text',
    ],
    [
      "case(when damage > 100 then 'big', when damage > 10 then 'mid', else 'small')",
      '(CASE WHEN ("t"."damage" > 100) THEN $1::text WHEN ("t"."damage" > 10) THEN $2::text ELSE $3::text END)',
      'text',
    ],
    ['case when victims > 0 then 1 end', '(CASE WHEN ("t"."victims" > 0) THEN 1 END)', 'number'],
    [
      "case when is_confirmed then reported_on else '2026-01-01' end",
      '(CASE WHEN "t"."is_confirmed" THEN "t"."reported_on" ELSE $1::date END)',
      'date',
    ],
  ])

  it.each([
    ['if(damage, 1, 2)', 'Ожидалось: условие, а получено: число', 3],
    ["if(damage > 0, 1, 'a')", 'У значений в ветки if() разные типы', 18],
    ['case when title then 1 end', 'Ожидалось: условие, а получено: строка', 10],
    ["case when is_confirmed then 1 else 'x' end", 'У значений в ветки case разные типы', 35],
    ['if(is_confirmed, 1)', 'Функция if() принимает аргументов: 3, а передано: 2', 0],
  ])('ошибка: %s', (source, message, position) => {
    const error = failure(source)
    expect(error.message).toBe(message)
    expect(error.position).toBe(position)
  })
})

describe('гео', () => {
  checkCases([
    [
      'st_distance(geom, st_point(68.78, 38.56))',
      'ST_Distance("t"."geom"::geography, ST_SetSRID(ST_MakePoint(68.78, 38.56), 4326)::geography)',
      'number',
    ],
    ['st_within(geom, geom)', 'ST_Within("t"."geom", "t"."geom")', 'boolean'],
    [
      'st_intersects(geom, st_buffer(geom, 100))',
      'ST_Intersects("t"."geom", ST_Buffer("t"."geom"::geography, 100)::geometry)',
      'boolean',
    ],
    ['st_area(geom)', '(ST_Area("t"."geom"::geography) / 1000000.0)', 'number'],
    ['st_length(geom)', '(ST_Length("t"."geom"::geography) / 1000.0)', 'number'],
    ['st_buffer(geom, 500)', 'ST_Buffer("t"."geom"::geography, 500)::geometry', 'geometry'],
    ['st_centroid(geom)', 'ST_Centroid("t"."geom")', 'geometry'],
    ['st_x(st_centroid(geom))', 'ST_X(ST_Centroid("t"."geom"))', 'number'],
    ['st_y(geom)', 'ST_Y("t"."geom")', 'number'],
  ])

  it.each([
    ['st_area(title)', 'Ожидалось: геометрия, а получено: строка', 8],
    ['st_distance(geom)', 'Функция st_distance() принимает аргументов: 2, а передано: 1', 0],
    ["st_point('x', 1)", 'Ожидалось: число, а получено: строка', 9],
    ["st_buffer(geom, 'x')", 'Ожидалось: число, а получено: строка', 16],
  ])('ошибка: %s', (source, message, position) => {
    const error = failure(source)
    expect(error.message).toBe(message)
    expect(error.position).toBe(position)
  })
})

describe('справочники, пользователь, параметры, макросы', () => {
  checkCases([
    ["user_attr('level')", '$1::double precision', 'number', [3]],
    ["user_attr('region')", '$1::text', 'text', ['DU']],
    ["user_attr('region') = kind", '($1::text = "t"."kind")', 'boolean'],
    ["user_attr('missing')", 'NULL', 'null'],
    ['@param:p_num + 1', '($1::double precision + 1)', 'number', [5]],
    ['damage > @param:p_num', '("t"."damage" > $1::double precision)', 'boolean'],
    ['title = @param:p_text', '("t"."title" = $1::text)', 'boolean', ['abc']],
    ['reported_on >= @param:p_date', '("t"."reported_on" >= $1::date)', 'boolean', ['2026-01-01']],
    [
      'occurred_at >= @param:p_date',
      '("t"."occurred_at" >= ($1::date::timestamp AT TIME ZONE $2::text))',
      'boolean',
    ],
    [
      'occurred_at >= @param:p_untyped',
      '("t"."occurred_at" >= ($1::timestamp AT TIME ZONE $2::text))',
      'boolean',
      ['2026-02-01', 'Asia/Dushanbe'],
    ],
    ['occurred_at < @param:p_dt', '("t"."occurred_at" < $1::timestamptz)', 'boolean'],
    ['damage > @param:p_missing', '("t"."damage" > NULL::double precision)', 'boolean', []],
    ['assignee = @me', '("t"."assignee" = $1::uuid)', 'boolean', [ME]],
    ['assignee = @my_unit', '("t"."assignee" = $1::uuid)', 'boolean', [UNITS[0]]],
    ['reported_on = @today', '("t"."reported_on" = $1::date)', 'boolean', ['2026-09-18']],
    ['occurred_at < @now', '("t"."occurred_at" < $1::timestamptz)', 'boolean', [NOW_ISO]],
    // Справочные функции — подстановка jsonb одним параметром (ADR-0057)
    [
      "territory_level(territory_id, 'region')",
      '(($1::jsonb ->> ("t"."territory_id")::text)::uuid)',
      'uuid',
      ['territory_level:id:region'],
    ],
    [
      "territory_level(code, 'district')",
      '($1::jsonb ->> "t"."code")',
      'text',
      ['territory_level:code:district'],
    ],
    [
      'territory_name(territory_id)',
      '($1::jsonb ->> ("t"."territory_id")::text)',
      'text',
      ['territory_name:id'],
    ],
    [
      "territory_name(territory_level(territory_id, 'region'))",
      '($2::jsonb ->> ((($1::jsonb ->> ("t"."territory_id")::text)::uuid))::text)',
      'text',
      ['territory_level:id:region', 'territory_name:id'],
    ],
    [
      "territory_level(territory_id, 'region') = territory_level(territory_id, 'region')",
      '((($1::jsonb ->> ("t"."territory_id")::text)::uuid) = (($1::jsonb ->> ("t"."territory_id")::text)::uuid))',
      'boolean',
      ['territory_level:id:region'],
    ],
    [
      'lookup_label(kind)',
      '($1::jsonb ->> ("t"."kind")::text)',
      'text',
      ['lookup_label:types:code:name'],
    ],
  ])

  it('предок территории — сам территория: подписи и фильтры работают с ним как с полем', () => {
    expect(compile("territory_level(territory_id, 'country')").fieldType).toBe('territory')
    expect(compile("territory_level(code, 'country')").fieldType).toBeUndefined()
  })

  it('без справочных подстановок функции недоступны', () => {
    expect(failure('territory_name(territory_id)', { noReferences: true }).message).toBe(
      'Справочные функции в этом выражении недоступны',
    )
  })

  it.each([
    ['lookup_label(title)', 'lookup_label() принимает поле, связанное со справочником', 13],
    ['lookup_label(reg.name)', 'lookup_label() принимает поле, связанное со справочником', 13],
    [
      'territory_name(assignee)',
      'territory_name() принимает территорию или код территории, а получено: ссылка',
      15,
    ],
    ["territory_level(territory_id, 'state')", 'Уровень территории — строка из списка', 30],
    ['territory_level(territory_id, 2)', 'Уровень территории — строка из списка', 30],
    ['user_attr(kind)', 'Имя атрибута пишется строкой', 10],
    ['@param:unknown > 1', 'Неизвестный параметр «unknown»', 0],
    ['reported_on = @param:p_bad_date', '«01.02.2026» — не дата', 14],
    ['nope > 1', 'Нет поля «nope»', 0],
    ['reg.nope', 'Нет поля «nope»', 0],
    ['foo(1)', 'Неизвестная функция foo()', 0],
  ])('ошибка: %s', (source, message, position) => {
    const error = failure(source)
    expect(error.message).toBe(message)
    expect(error.position).toBe(position)
  })
})

describe('агрегаты', () => {
  const agg: Options = { mode: 'aggregate' }
  checkCases(
    [
      ['count()', 'count(*)', 'number'],
      ['count(title)', 'count("t"."title")', 'number'],
      ['count_distinct(kind)', 'count(DISTINCT "t"."kind")', 'number'],
      ['sum(damage)', 'sum("t"."damage")', 'number'],
      ['avg(victims)', 'avg("t"."victims")', 'number'],
      ['min(reported_on)', 'min("t"."reported_on")', 'date'],
      ['max(title)', 'max("t"."title")', 'text'],
      ['median(damage)', 'percentile_cont(0.5) WITHIN GROUP (ORDER BY "t"."damage")', 'number'],
      [
        'percentile(damage, 0.9)',
        'percentile_cont(0.9) WITHIN GROUP (ORDER BY "t"."damage")',
        'number',
      ],
      ["string_agg(title, ', ')", 'string_agg(("t"."title")::text, $1::text)', 'text', [', ']],
      [
        'sum(damage) / count()',
        '(sum("t"."damage")::double precision / NULLIF(count(*)::double precision, 0))',
        'number',
      ],
      [
        'count() / max(reg.population) * 100000',
        '((count(*)::double precision / NULLIF(max("r"."population")::double precision, 0)) * 100000)',
        'number',
      ],
      ['sum(damage * victims)', 'sum(("t"."damage" * "t"."victims"))', 'number'],
      ['round(avg(damage), 2)', 'round(avg("t"."damage")::numeric, 2)::double precision', 'number'],
      ['1', '1', 'number'],
    ],
    agg,
  )

  it('поле группировки допустимо вне агрегата', () => {
    expect(sql("kind || ': ' || count()", { mode: 'aggregate', groupKeys: ['kind'] })).toBe(
      '(("t"."kind" || $1::text) || count(*)::text)',
    )
  })

  it('признаки: агрегат и тип поля count()', () => {
    const compiled = compile('count()', { mode: 'aggregate' })
    expect(compiled.aggregate).toBe(true)
    expect(compiled.fieldType).toBe('integer')
    expect(compile('max(damage)', { mode: 'aggregate' }).fieldType).toBe('money')
    expect(compile('damage + 1').aggregate).toBe(false)
  })

  it('условная мера: FILTER у каждого агрегата', () => {
    const filter = '("t"."kind" = $9::text)'
    expect(sql('sum(damage)', { mode: 'aggregate', filter })).toBe(
      'sum("t"."damage") FILTER (WHERE ("t"."kind" = $9::text))',
    )
    expect(sql('sum(damage) / count()', { mode: 'aggregate', filter })).toBe(
      '(sum("t"."damage") FILTER (WHERE ("t"."kind" = $9::text))::double precision / NULLIF(count(*) FILTER (WHERE ("t"."kind" = $9::text))::double precision, 0))',
    )
    expect(sql('median(damage)', { mode: 'aggregate', filter })).toBe(
      'percentile_cont(0.5) WITHIN GROUP (ORDER BY "t"."damage") FILTER (WHERE ("t"."kind" = $9::text))',
    )
  })

  it.each([
    ['sum(sum(damage))', 'Агрегат sum() нельзя вкладывать в другой агрегат', 4],
    ['damage + sum(damage)', 'Поле «damage» вне агрегата должно быть в группировке', 0],
    ['sum(title)', 'Ожидалось: число, а получено: строка', 4],
    ['min(geom)', 'Ожидалось: сравнимое значение, а получено: геометрия', 4],
    ['percentile(damage, 2)', 'Доля перцентиля — число от 0 до 1', 19],
    ['percentile(damage, ratio)', 'Доля перцентиля — число от 0 до 1', 19],
    ['string_agg(title, 1)', 'Ожидалось: разделитель-строка, а получено: число', 18],
    ['count(1, 2)', 'Функция count() принимает аргументов: 0–1', 0],
    ['avg()', 'Функция avg() принимает аргументов: 1', 0],
  ])('ошибка: %s', (source, message, position) => {
    const error = failure(source, { mode: 'aggregate' })
    expect(error.message).toBe(message)
    expect(error.position).toBe(position)
  })

  it('агрегат вне сводки — подсказка про шаг «Сводка»', () => {
    const error = failure('count()')
    expect(error.message).toBe('Агрегат count() допустим только в мере сводки')
    expect(error.hint).toBe('Добавьте шаг «Сводка» (aggregate) и опишите меру там')
  })

  it.each(['lag', 'lead', 'rank', 'dense_rank', 'row_number', 'running_sum', 'moving_avg'])(
    'оконная функция %s — через шаг «Окно»',
    (name) => {
      const error = failure(`${name}(damage)`)
      expect(error.message).toBe(`Оконная функция ${name}() недоступна в выражении`)
      expect(error.hint).toBe('Используйте шаг «Окно» (window)')
    },
  )
})

describe('условие', () => {
  it('должно быть логическим', () => {
    const error = failure('damage + 1', { condition: true })
    expect(error.message).toBe('Условие должно быть логическим, а получилось: число')
    expect(error.hint).toBe('Добавьте сравнение, например «поле > 0»')
  })

  it('логическое и пустое — допустимы', () => {
    expect(sql('damage > 0', { condition: true })).toBe('("t"."damage" > 0)')
    expect(sql('null', { condition: true })).toBe('NULL')
    expect(sql('is_confirmed', { condition: true })).toBe('"t"."is_confirmed"')
  })
})
