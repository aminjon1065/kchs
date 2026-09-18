import type { QueryIssue, QuerySpec } from '@kchs/contracts'
import { describe, expect, it } from 'vitest'
import { type CompileContext, compileQuery, QueryCompileError } from '../src/index.js'
import { ctx, IDS, incidents, q, src, USER_ID, withDatasets } from './fixtures.js'

function issue(spec: QuerySpec, overrides?: Partial<CompileContext>): QueryIssue {
  try {
    compileQuery(spec, ctx(overrides))
  } catch (error) {
    if (error instanceof QueryCompileError) return error.issues[0] as QueryIssue
    throw error
  }
  throw new Error('Компиляция прошла без ошибки')
}

type Case = [
  name: string,
  spec: QuerySpec,
  expected: Partial<QueryIssue>,
  overrides?: Partial<CompileContext>,
]

function check(cases: Case[]) {
  it.each(cases)('%s', (_name, spec, expected, overrides) => {
    expect(issue(spec, overrides)).toMatchObject(expected)
  })
}

const regionsSource = { kind: 'dataset', id: IDS.regions, alias: 'reg' } as const
const archiveSource = { kind: 'dataset', id: IDS.archive, alias: 'arc' } as const
const hiddenDamage = withDatasets({ ...incidents, columnPolicy: { hide: ['damage'], mask: [] } })
const where = (condition: QuerySpec['steps'][number]) => q(src('inc'), [condition])

describe('источники', () => {
  check([
    [
      'датасет не найден',
      q({ kind: 'dataset', id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }),
      { path: ['source', 'id'], message: 'Датасет не найден или нет доступа' },
    ],
    [
      'системный датасет не передан',
      q({ kind: 'system', name: 'tasks' }),
      { path: ['source', 'name'], message: 'Системный датасет «tasks» недоступен' },
    ],
    [
      'источник SQL',
      q({ kind: 'sql', sql: 'select 1' }),
      {
        path: ['source'],
        message: 'Источник SQL выполняется только в SQL-лаборатории',
        hint: 'В визуальном запросе используйте датасет или сохранённый запрос',
      },
    ],
    [
      'сохранённый запрос не найден',
      q({ kind: 'query', id: IDS.savedTotals }),
      { path: ['source', 'id'], message: 'Сохранённый запрос не найден или нет доступа' },
    ],
    [
      'сохранённый запрос ссылается сам на себя',
      q({ kind: 'query', id: IDS.savedLoop }),
      {
        path: ['source', 'source', 'id'],
        message: 'Сохранённый запрос ссылается сам на себя',
      },
      { queries: new Map([[IDS.savedLoop, q({ kind: 'query', id: IDS.savedLoop })]]) },
    ],
    [
      'ошибка внутри сохранённого запроса — путь от внешнего источника',
      q({ kind: 'query', id: IDS.savedTotals }),
      {
        path: ['source', 'steps', 0, 'where', 'field'],
        message: 'Сохранённый запрос: Нет поля «nope»',
      },
      {
        queries: new Map([
          [
            IDS.savedTotals,
            q(src(), [{ type: 'filter', where: { field: 'nope', op: 'eq', value: 1 } }]),
          ],
        ]),
      },
    ],
    [
      'встроенные строки: пусто',
      q({ kind: 'inline', rows: [] }),
      { path: ['source', 'rows'], message: 'Во встроенном источнике нет строк' },
    ],
    [
      'встроенные строки: недопустимое имя',
      q({ kind: 'inline', rows: [{ 'bad key': 1 }] }),
      { path: ['source', 'rows', 0, 'bad key'], message: 'Недопустимое имя столбца «bad key»' },
    ],
    [
      'встроенные строки: разные типы',
      q({ kind: 'inline', rows: [{ a: 1 }, { a: 'x' }] }),
      { path: ['source', 'rows', 1, 'a'], message: 'В столбце «a» значения разных типов' },
    ],
    [
      'версия спецификации',
      { ...q(src()), version: 2 as 1 },
      { path: ['version'], message: 'Версия спецификации 2 не поддерживается' },
    ],
    [
      'часовой пояс',
      q(src()),
      { path: [], message: 'Недопустимый часовой пояс «Mars/Base»' },
      { timezone: 'Mars/Base' },
    ],
    [
      'часовой пояс с попыткой внедрения',
      q(src()),
      { path: [], message: "Недопустимый часовой пояс «UTC'; drop table x; --»" },
      { timezone: "UTC'; drop table x; --" },
    ],
  ])
})

describe('шаги', () => {
  check([
    [
      'spatial не поддерживается',
      q(src(), [{ type: 'spatial', op: 'buffer', params: {} }]),
      { path: ['steps', 0, 'type'], message: 'Шаг «spatial» не поддерживается в фазе 1' },
    ],
    [
      'pivot не поддерживается',
      q(src(), [
        { type: 'pivot', rows: ['kind'], columns: 'territory_id', measure: { agg: 'count' } },
      ]),
      { path: ['steps', 0, 'type'], message: 'Шаг «pivot» не поддерживается в фазе 1' },
    ],
    [
      'вычисление: имя уже есть',
      q(src(), [{ type: 'compute', fields: [{ name: 'title', expr: '1' }] }]),
      { path: ['steps', 0, 'fields', 0, 'name'], message: 'Поле «title» уже есть' },
    ],
    [
      'вычисление: объявлен другой тип',
      q(src(), [{ type: 'compute', fields: [{ name: 'x', expr: 'title', type: 'number' }] }]),
      {
        path: ['steps', 0, 'fields', 0, 'type'],
        message: 'Выражение даёт «строка», а объявлено «число»',
      },
    ],
    [
      'вычисление: ошибка выражения с позицией',
      q(src(), [{ type: 'compute', fields: [{ name: 'x', expr: 'damage +' }] }]),
      {
        path: ['steps', 0, 'fields', 0, 'expr'],
        message: 'Ожидалось значение, а встретилось конец выражения',
        position: 8,
      },
    ],
    [
      'вычисление: агрегат вне сводки',
      q(src(), [{ type: 'compute', fields: [{ name: 'x', expr: 'count() / 2' }] }]),
      {
        path: ['steps', 0, 'fields', 0, 'expr'],
        message: 'Агрегат count() допустим только в мере сводки',
        position: 0,
      },
    ],
    [
      'сводка: пусто',
      q(src(), [{ type: 'aggregate', groupBy: [], measures: [] }]),
      { path: ['steps', 0], message: 'В сводке нужны группировка или меры' },
    ],
    [
      'сводка: повтор имени',
      q(src(), [
        {
          type: 'aggregate',
          groupBy: [{ field: 'kind' }],
          measures: [{ alias: 'kind', agg: 'count' }],
        },
      ]),
      { path: ['steps', 0, 'measures', 0, 'alias'], message: 'Имя «kind» в сводке повторяется' },
    ],
    [
      'сводка: интервал не для даты',
      q(src(), [
        { type: 'aggregate', groupBy: [{ field: 'kind', bucket: 'month' }], measures: [] },
      ]),
      {
        path: ['steps', 0, 'groupBy', 0, 'bucket'],
        message: 'Интервал времени применим к дате, а «kind» — строка',
      },
    ],
    [
      'сводка: час для даты',
      q(src(), [
        { type: 'aggregate', groupBy: [{ field: 'reported_on', bucket: 'hour' }], measures: [] },
      ]),
      { path: ['steps', 0, 'groupBy', 0, 'bucket'], message: 'Дату нельзя разбить по часам' },
    ],
    [
      'сводка: мера без поля',
      q(src(), [
        { type: 'aggregate', groupBy: [], measures: [{ alias: 'n', agg: 'count_distinct' }] },
      ]),
      {
        path: ['steps', 0, 'measures', 0, 'field'],
        message: 'Для меры «count_distinct» нужно поле',
      },
    ],
    [
      'сводка: сумма строк',
      q(src(), [
        { type: 'aggregate', groupBy: [], measures: [{ alias: 's', agg: 'sum', field: 'title' }] },
      ]),
      {
        path: ['steps', 0, 'measures', 0, 'field'],
        message: 'Мера «sum» считается по числам, а получено: строка',
      },
    ],
    [
      'сводка: first без порядка',
      q({ kind: 'inline', rows: [{ a: 1 }] }, [
        { type: 'aggregate', groupBy: [], measures: [{ alias: 'f', agg: 'first', field: 'a' }] },
      ]),
      {
        path: ['steps', 0, 'measures', 0],
        message: 'Для first/last нужен порядок строк',
        hint: 'Добавьте шаг сортировки перед сводкой',
      },
    ],
    [
      'сводка: expr без выражения',
      q(src(), [{ type: 'aggregate', groupBy: [], measures: [{ alias: 'e', agg: 'expr' }] }]),
      { path: ['steps', 0, 'measures', 0, 'expr'], message: 'Для меры expr нужно выражение' },
    ],
    [
      'сводка: ошибка в мере-выражении',
      q(src(), [
        {
          type: 'aggregate',
          groupBy: [],
          measures: [{ alias: 'e', agg: 'expr', expr: 'sum(title)' }],
        },
      ]),
      {
        path: ['steps', 0, 'measures', 0, 'expr'],
        message: 'Ожидалось: число, а получено: строка',
        position: 4,
      },
    ],
    [
      'сводка: поле вне группировки',
      q(src(), [
        {
          type: 'aggregate',
          groupBy: [{ field: 'kind' }],
          measures: [{ alias: 'e', agg: 'expr', expr: 'title || count()' }],
        },
      ]),
      {
        path: ['steps', 0, 'measures', 0, 'expr'],
        message: 'Поле «title» вне агрегата должно быть в группировке',
        position: 0,
      },
    ],
    [
      'после сводки исходные поля недоступны',
      q(src(), [
        {
          type: 'aggregate',
          groupBy: [{ field: 'kind' }],
          measures: [{ alias: 'n', agg: 'count' }],
        },
        { type: 'filter', where: { field: 'damage', op: 'gt', value: 1 } },
      ]),
      { path: ['steps', 1, 'where', 'field'], message: 'Нет поля «damage»' },
    ],
    [
      'окно: нет порядка',
      q(src(), [
        {
          type: 'window',
          fields: [{ alias: 'p', fn: 'lag', field: 'damage', partitionBy: [], orderBy: [] }],
        },
      ]),
      { path: ['steps', 0, 'fields', 0, 'orderBy'], message: 'Для «lag» нужен порядок (orderBy)' },
    ],
    [
      'окно: нет поля',
      q(src(), [
        {
          type: 'window',
          fields: [{ alias: 'p', fn: 'lag', partitionBy: [], orderBy: ['reported_on'] }],
        },
      ]),
      { path: ['steps', 0, 'fields', 0, 'field'], message: 'Для «lag» нужно поле' },
    ],
    [
      'окно: сумма строк',
      q(src(), [
        {
          type: 'window',
          fields: [
            {
              alias: 'c',
              fn: 'running_sum',
              field: 'title',
              partitionBy: [],
              orderBy: ['reported_on'],
            },
          ],
        },
      ]),
      {
        path: ['steps', 0, 'fields', 0, 'field'],
        message: '«running_sum» считается по числам, а «title» — строка',
      },
    ],
    [
      'окно: имя уже есть',
      q(src(), [
        {
          type: 'window',
          fields: [{ alias: 'title', fn: 'row_number', partitionBy: [], orderBy: [] }],
        },
      ]),
      { path: ['steps', 0, 'fields', 0, 'alias'], message: 'Поле «title» уже есть' },
    ],
    [
      'сортировка по геометрии',
      q(src(), [{ type: 'sort', by: [{ field: 'geom', dir: 'asc' }] }]),
      {
        path: ['steps', 0, 'by', 0, 'field'],
        message: 'По полю типа «геометрия» нельзя сортировать',
      },
    ],
    [
      'лимит вне диапазона',
      q(src(), [{ type: 'limit', limit: -1, offset: 0 }]),
      { path: ['steps', 0, 'limit'], message: 'Нужно целое число от 0 до 1000000' },
    ],
    [
      'выбор: поле дважды',
      q(src(), [{ type: 'select', fields: ['title', 'title'] }]),
      { path: ['steps', 0, 'fields', 1], message: 'Поле «title» выбрано дважды' },
    ],
    [
      'соединение: алиас занят',
      q(src('inc'), [
        {
          type: 'join',
          source: { kind: 'dataset', id: IDS.regions, alias: 'inc' },
          on: [{ left: 'inc.territory_id', right: 'inc.territory_id' }],
          kind: 'left',
        },
      ]),
      { path: ['steps', 0, 'source', 'alias'], message: 'Алиас «inc» уже используется' },
    ],
    [
      'соединение: несовместимые типы',
      q(src('inc'), [
        {
          type: 'join',
          source: regionsSource,
          on: [{ left: 'inc.damage', right: 'reg.name' }],
          kind: 'left',
        },
      ]),
      { path: ['steps', 0, 'on', 0], message: 'Нельзя соединить «число» и «строка»' },
    ],
    [
      'соединение: поле неоднозначно',
      q(src('inc'), [
        {
          type: 'join',
          source: archiveSource,
          on: [{ left: 'inc.title', right: 'arc.title' }],
          kind: 'left',
        },
        { type: 'filter', where: { field: 'kind', op: 'eq', value: 'fire' } },
      ]),
      {
        path: ['steps', 1, 'where', 'field'],
        message: 'Поле «kind» неоднозначно',
        hint: 'Укажите источник: inc.kind или arc.kind',
      },
    ],
    [
      'объединение: несовместимые типы',
      q(src(), [
        { type: 'select', fields: [{ field: 'victims', alias: 'title' }] },
        { type: 'union', source: archiveSource, mode: 'all' },
      ]),
      {
        path: ['steps', 1, 'source'],
        message: 'Поле «title»: нельзя объединить «число» и «строка»',
      },
    ],
    [
      'объединение: повтор имён слева',
      q(src('inc'), [
        {
          type: 'join',
          source: archiveSource,
          on: [{ left: 'inc.title', right: 'arc.title' }],
          kind: 'left',
        },
        { type: 'union', source: archiveSource, mode: 'all' },
      ]),
      { path: ['steps', 1], message: 'Поле «title» повторяется в текущем результате' },
    ],
    [
      'развёртка не списка',
      q(src(), [{ type: 'unnest', field: 'title' }]),
      {
        path: ['steps', 0, 'field'],
        message: 'Развернуть можно только список, а «title» — строка',
      },
    ],
  ])
})

describe('поля и доступ', () => {
  check([
    [
      'скрытое поле в фильтре',
      where({ type: 'filter', where: { field: 'damage', op: 'gt', value: 1 } }),
      { path: ['steps', 0, 'where', 'field'], message: 'Нет доступа к полю «damage»' },
      hiddenDamage,
    ],
    [
      'скрытое поле в выражении',
      where({ type: 'compute', fields: [{ name: 'x', expr: 'inc.damage * 2' }] }),
      {
        path: ['steps', 0, 'fields', 0, 'expr'],
        message: 'Нет доступа к полю «inc.damage»',
        position: 0,
      },
      hiddenDamage,
    ],
    [
      'скрытое поле в сортировке',
      where({ type: 'sort', by: [{ field: 'damage', dir: 'asc' }] }),
      { path: ['steps', 0, 'by', 0, 'field'], message: 'Нет доступа к полю «damage»' },
      hiddenDamage,
    ],
    [
      'скрытое поле в соединении',
      q(src('inc'), [
        {
          type: 'join',
          source: regionsSource,
          on: [{ left: 'inc.damage', right: 'reg.population' }],
          kind: 'left',
        },
      ]),
      { path: ['steps', 0, 'on', 0, 'left'], message: 'Нет доступа к полю «inc.damage»' },
      hiddenDamage,
    ],
    [
      'вычисляемое поле датасета',
      where({ type: 'filter', where: { field: 'score_formula', op: 'eq', value: 1 } }),
      {
        path: ['steps', 0, 'where', 'field'],
        message: 'Поле «score_formula» вычисляемое — в запросах к данным оно пока недоступно',
      },
    ],
    [
      'опечатка в имени поля',
      where({ type: 'filter', where: { field: 'damag', op: 'gt', value: 1 } }),
      { message: 'Нет поля «damag»', hint: 'Возможно, имелось в виду: damage' },
    ],
    [
      'неизвестный источник',
      where({ type: 'filter', where: { field: 'foo.title', op: 'eq', value: 'x' } }),
      { message: 'Неизвестный источник «foo»', hint: 'Доступны: inc' },
    ],
  ])
})

describe('фильтры', () => {
  const filter = (condition: object) => where({ type: 'filter', where: condition as never })
  check([
    [
      'оператор не для типа',
      filter({ field: 'damage', op: 'contains', value: 'x' }),
      {
        path: ['steps', 0, 'where', 'op'],
        message: 'Оператор «contains» не применим к полю «damage» (число)',
        hint: 'Допустимо: eq, neq, lt, lte, gt, gte, between, in, not_in, is_empty, not_empty',
      },
    ],
    [
      'не число',
      filter({ field: 'damage', op: 'gt', value: 'abc' }),
      { path: ['steps', 0, 'where', 'value'], message: 'Ожидалось число, а получено: "abc"' },
    ],
    [
      'нет такой даты',
      filter({ field: 'reported_on', op: 'eq', value: '2026-02-30' }),
      { path: ['steps', 0, 'where', 'value'], message: 'Нет такой даты: 2026-02-30' },
    ],
    [
      'не идентификатор в списке',
      filter({ field: 'territory_id', op: 'in', value: ['x'] }),
      {
        path: ['steps', 0, 'where', 'value', 0],
        message: 'Ожидался идентификатор, а получено: "x"',
      },
    ],
    [
      'длинное регулярное выражение',
      filter({ field: 'code', op: 'regex', value: 'a'.repeat(501) }),
      { message: 'Регулярное выражение длиннее 500 символов' },
    ],
    [
      'нет значения',
      filter({ field: 'title', op: 'eq' }),
      { path: ['steps', 0, 'where', 'value'], message: 'Для оператора «eq» нужно значение' },
    ],
    [
      'относительный период: единица',
      filter({ field: 'reported_on', op: 'relative', value: { unit: 'hour', from: 0, to: 0 } }),
      {
        path: ['steps', 0, 'where', 'value', 'unit'],
        message: 'Единица периода — одна из: day, week, month, quarter, year',
      },
    ],
    [
      'относительный период: начало позже конца',
      filter({ field: 'reported_on', op: 'relative', value: { unit: 'day', from: 1, to: -1 } }),
      { message: 'Начало периода (from) позже конца (to)' },
    ],
    [
      'между: не пара',
      filter({ field: 'victims', op: 'between', value: [1, 2, 3] }),
      { message: 'Для between нужна пара значений [от, до]' },
    ],
    [
      'в радиусе: без расстояния',
      filter({ field: 'geom', op: 'dwithin', value: { lon: 1, lat: 2 } }),
      {
        path: ['steps', 0, 'where', 'value', 'distance'],
        message: 'Расстояние — неотрицательное число метров',
      },
    ],
    [
      'пересечение: не GeoJSON',
      filter({ field: 'geom', op: 'intersects', value: { type: 'Circle' } }),
      { message: 'Ожидалась геометрия GeoJSON' },
    ],
    [
      'геометрия внутри территории — позже',
      filter({ field: 'geom', op: 'within', value: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1' }),
      { message: 'Поиск геометрий внутри территории появится со справочником территорий (P1-E07)' },
    ],
    [
      'within для пользователя',
      filter({ field: 'assignee', op: 'within', value: USER_ID }),
      {
        path: ['steps', 0, 'where', 'op'],
        message: 'Оператор «within» применим к территории или геометрии, а «assignee» — не такое',
      },
    ],
    [
      'within без иерархии территорий',
      filter({
        field: 'territory_id',
        op: 'within',
        value: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1',
      }),
      { message: 'Нет иерархии территорий для поиска с дочерними' },
      { territoryDescendants: undefined },
    ],
    [
      'in_my_unit для территории',
      filter({ field: 'territory_id', op: 'in_my_unit' }),
      {
        message:
          'Оператор «in_my_unit» применим к полю-пользователю или подразделению, а «territory_id» — не такое',
      },
    ],
    [
      'in_my_unit без сотрудников подразделения',
      filter({ field: 'assignee', op: 'in_my_unit' }),
      { message: 'Сотрудники подразделения недоступны для этого запроса' },
      { user: { id: USER_ID, unitIds: [], territoryIds: [], subordinateIds: [], attributes: {} } },
    ],
    [
      'обязательный параметр не задан',
      q(src(), [{ type: 'filter', where: { field: 'kind', op: 'eq', value: '@param:kind' } }], {
        kind: { type: 'text', required: true },
      }),
      { path: ['steps', 0, 'where', 'value'], message: 'Не задан обязательный параметр «kind»' },
    ],
    [
      'параметр не объявлен',
      filter({ field: 'kind', op: 'eq', value: '@param:nope' }),
      { message: 'Неизвестный параметр «nope»', hint: 'Объявите его в params запроса' },
    ],
  ])
})

describe('политики строк', () => {
  check([
    [
      'параметр в политике-фильтре',
      q(src()),
      {
        path: ['source', 'policy', 'where', 'value'],
        message: 'В политике строк параметры запроса недоступны',
      },
      withDatasets({
        ...incidents,
        rowPolicy: { kind: 'filter', where: { field: 'kind', op: 'eq', value: '@param:kind' } },
      }),
    ],
    [
      'параметр в политике-выражении',
      q(src()),
      {
        path: ['source', 'policy', 'expr'],
        message: 'В политике строк параметры запроса недоступны',
        position: 7,
      },
      withDatasets({ ...incidents, rowPolicy: { kind: 'expr', expr: 'kind = @param:kind' } }),
    ],
    [
      'неизвестное поле в политике',
      q(src()),
      { path: ['source', 'policy', 'where', 'field'], message: 'В политике строк нет поля «nope»' },
      withDatasets({
        ...incidents,
        rowPolicy: { kind: 'filter', where: { field: 'nope', op: 'is_empty' } },
      }),
    ],
    [
      'политика-выражение не логическая',
      q(src()),
      {
        path: ['source', 'policy', 'expr'],
        message: 'Условие должно быть логическим, а получилось: число',
      },
      withDatasets({ ...incidents, rowPolicy: { kind: 'expr', expr: 'victims + 1' } }),
    ],
  ])
})

describe('непроверенная спецификация не попадает в текст SQL', () => {
  const bad = <T>(value: unknown) => value as T
  check([
    [
      'направление сортировки',
      q(src(), [{ type: 'sort', by: [{ field: 'title', dir: bad('asc; drop table x') }] }]),
      { path: ['steps', 0, 'by', 0, 'dir'], message: 'Направление — asc или desc' },
    ],
    [
      'пустые значения в сортировке',
      q(src(), [{ type: 'sort', by: [{ field: 'title', dir: 'asc', nulls: bad('first, 1') }] }]),
      { path: ['steps', 0, 'by', 0, 'nulls'], message: 'Пустые значения — first или last' },
    ],
    [
      'интервал сводки',
      q(src(), [
        {
          type: 'aggregate',
          groupBy: [{ field: 'occurred_at', bucket: bad("month'); drop table x; --") }],
          measures: [],
        },
      ]),
      {
        path: ['steps', 0, 'groupBy', 0, 'bucket'],
        message: 'Интервал — один из: year, quarter, month, week, day, hour',
      },
    ],
    [
      'вид соединения',
      q(src('inc'), [
        {
          type: 'join',
          source: regionsSource,
          on: [{ left: 'inc.territory_id', right: 'reg.territory_id' }],
          kind: bad('cross'),
        },
      ]),
      { path: ['steps', 0, 'kind'], message: 'Вид соединения — inner, left, right или full' },
    ],
    [
      'неизвестный шаг',
      q(src(), [bad({ type: 'drop' })]),
      { path: ['steps', 0, 'type'], message: 'Неизвестный шаг «drop»' },
    ],
    [
      'неизвестный вид источника',
      q(bad({ kind: 'table', name: 'pg_authid' })),
      { path: ['source', 'kind'], message: 'Неизвестный вид источника' },
    ],
    [
      'неизвестная мера',
      q(src(), [
        { type: 'aggregate', groupBy: [], measures: [{ alias: 'x', agg: bad('pg_sleep') }] },
      ]),
      { path: ['steps', 0, 'measures', 0, 'agg'], message: 'Неизвестная мера «pg_sleep»' },
    ],
    [
      'неизвестная оконная функция',
      q(src(), [
        {
          type: 'window',
          fields: [{ alias: 'x', fn: bad('pg_sleep'), partitionBy: [], orderBy: ['title'] }],
        },
      ]),
      { path: ['steps', 0, 'fields', 0, 'fn'], message: 'Неизвестная оконная функция «pg_sleep»' },
    ],
    [
      'неизвестный оператор фильтра',
      where({ type: 'filter', where: { field: 'title', op: bad('raw'), value: '1=1' } }),
      {
        path: ['steps', 0, 'where', 'op'],
        message: 'Оператор «raw» не применим к полю «title» (строка)',
      },
    ],
  ])

  it('имена результата всегда в кавычках', () => {
    const compiled = compileQuery(
      q(src(), [{ type: 'select', fields: [{ field: 'title', alias: 'x"; drop table t; --' }] }]),
      ctx(),
    )
    expect(compiled.sql).toContain('AS "x""; drop table t; --"')
    expect(compiled.fields[0]?.name).toBe('x"; drop table t; --')
  })
})

describe('ошибки программиста — не ошибки спецификации', () => {
  it('недопустимое физическое имя столбца', () => {
    const broken = {
      ...incidents,
      fields: [{ key: 'x', type: 'text' as const, physical: 'c_1; drop' }],
    }
    expect(() => compileQuery(q(src()), ctx(withDatasets(broken)))).toThrow(
      'Недопустимое физическое имя столбца: c_1; drop',
    )
  })

  it('недопустимое имя таблицы', () => {
    const broken = { ...incidents, table: 'ds.t_x"; drop' }
    expect(() => compileQuery(q(src()), ctx(withDatasets(broken)))).toThrow(
      'Недопустимое имя таблицы',
    )
  })

  it('недопустимый предел строк', () => {
    expect(() => compileQuery(q(src()), ctx({ maxRows: -5 }))).toThrow('maxRows')
  })
})

describe('QueryCompileError', () => {
  it('список проблем и сообщение', () => {
    const error = new QueryCompileError([
      { path: ['steps', 0], message: 'Первая' },
      { path: [], message: 'Вторая', hint: 'подсказка' },
    ])
    expect(error.name).toBe('QueryCompileError')
    expect(error.message).toBe('Первая; Вторая')
    expect(error.issues).toHaveLength(2)
    expect(error).toBeInstanceOf(Error)
  })
})
