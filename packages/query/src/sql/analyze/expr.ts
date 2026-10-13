import {
  isAllowedFunction,
  isAllowedType,
  isDeniedFunction,
  OPERATOR,
  TIME_VALUE_FUNCTIONS,
  VOLATILE_FUNCTIONS,
} from '../allowlist.js'
import { type Placeholder, sqlFail } from '../text.js'
import { BETWEEN_KINDS, EXPR_KINDS, SUBLINKS, UNSUPPORTED } from './grammar.js'
import { type ExprCtx, INPUT, isObj, list, type Obj, type Output, type Scope } from './model.js'
import { NameResolver } from './names.js'

const FUNCTION_HINT =
  'Доступны агрегаты, оконные, математические и строковые функции, функции дат, JSON, массивов и PostGIS'
const TYPE_HINT =
  'Доступны числа, строки, логический тип, даты и время, интервалы, uuid, json/jsonb и геометрия'

/** Слой 3: выражения, функции и типы по белым спискам; сортировка, группировка, окна. */
export abstract class ExprAnalyzer extends NameResolver {
  /** Подзапрос в выражении (SubLink) разбирает слой операторов. */
  protected abstract select(stmt: Obj, parent: Scope | null, pos: number): Output[]
  protected abstract nodeSelect(value: unknown, pos: number): [string, Obj]

  protected groupItem(value: unknown, scope: Scope, outputs: readonly Output[], pos: number): void {
    if (isObj(value) && isObj(value.GroupingSet)) {
      const [, fields] = this.node(value, pos)
      const at = this.at(fields.location, pos)
      for (const item of list(fields.content)) this.groupItem(item, scope, outputs, at)
      return
    }
    this.orderItem(value, scope, outputs, 'group', pos)
  }

  protected sortBy(
    value: unknown,
    scope: Scope,
    outputs: readonly Output[] | null,
    pos: number,
  ): void {
    const [type, fields] = this.node(value, pos)
    if (type !== 'SortBy') sqlFail('Конструкция SQL не поддерживается', pos)
    const at = this.at(fields.location, pos)
    if (fields.useOp !== undefined) this.operator(fields.useOp, 'AEXPR_OP', at)
    if (outputs) this.orderItem(fields.node, scope, outputs, 'order', at)
    else this.expr(fields.node, scope, INPUT, at)
  }

  /** Элемент ORDER BY / GROUP BY / DISTINCT ON: голое имя может быть именем результата. */
  protected orderItem(
    value: unknown,
    scope: Scope,
    outputs: readonly Output[],
    names: 'order' | 'group',
    pos: number,
  ): void {
    if (isObj(value) && isObj(value.ColumnRef)) {
      const [, ref] = this.node(value, pos)
      const parts = this.columnParts(ref, pos)
      if (parts.length === 1 && parts[0] !== null) {
        this.columnRef(
          ref,
          scope,
          { names, outputs, bareTarget: false },
          this.at(ref.location, pos),
        )
        return
      }
    }
    this.expr(value, scope, INPUT, pos)
  }

  protected windowDef(fields: Obj, scope: Scope, pos: number): void {
    this.check('WindowDef', fields, pos)
    const at = this.at(fields.location, pos)
    for (const item of list(fields.partitionClause)) this.expr(item, scope, INPUT, at)
    for (const item of list(fields.orderClause)) this.sortBy(item, scope, null, at)
    this.expr(fields.startOffset, scope, INPUT, at)
    this.expr(fields.endOffset, scope, INPUT, at)
  }

  protected expr(value: unknown, scope: Scope, ctx: ExprCtx, pos: number): void {
    if (value === undefined || value === null) return
    const [type, fields] = this.node(value, pos)
    const at = this.at(fields.location, pos)
    // Особые правила имён (голое поле выборки, ORDER BY) — только у элемента верхнего уровня
    const inner = INPUT
    switch (type) {
      case 'ColumnRef':
        this.columnRef(fields, scope, ctx, at)
        return
      case 'ParamRef':
        this.paramRef(fields, at)
        return
      case 'A_Const':
        return
      case 'TypeCast':
        // Сначала аргумент: в `x::a::b` ошибка указывает на первое приведение в тексте
        this.expr(fields.arg, scope, inner, at)
        this.typeName(fields.typeName, at)
        return
      case 'A_Expr': {
        const kind = String(fields.kind)
        if (!EXPR_KINDS.has(kind) && !BETWEEN_KINDS.has(kind)) {
          sqlFail('Конструкция SQL не поддерживается', at)
        }
        this.operator(fields.name, kind, at)
        this.expr(fields.lexpr, scope, inner, at)
        this.expr(fields.rexpr, scope, inner, at)
        return
      }
      case 'List':
        for (const item of list(fields.items)) this.expr(item, scope, inner, pos)
        return
      case 'BoolExpr':
      case 'CoalesceExpr':
      case 'MinMaxExpr':
      case 'GroupingFunc':
      case 'RowExpr':
        for (const item of list(fields.args)) this.expr(item, scope, inner, at)
        return
      case 'NullTest':
      case 'BooleanTest':
        this.expr(fields.arg, scope, inner, at)
        return
      case 'A_ArrayExpr':
        for (const item of list(fields.elements)) this.expr(item, scope, inner, at)
        return
      case 'FuncCall':
        this.funcCall(fields, scope, at)
        return
      case 'CaseExpr':
        this.expr(fields.arg, scope, inner, at)
        for (const item of list(fields.args)) this.expr(item, scope, inner, at)
        this.expr(fields.defresult, scope, inner, at)
        return
      case 'CaseWhen':
        this.expr(fields.expr, scope, inner, at)
        this.expr(fields.result, scope, inner, at)
        return
      case 'SQLValueFunction': {
        const op = String(fields.op)
        if (!TIME_VALUE_FUNCTIONS.has(op)) {
          const shown = op.replace(/^SVFOP_/, '').replace(/_N$/, '')
          sqlFail(`Системная функция «${shown}» недоступна`, at)
        }
        this.usesTime = true
        return
      }
      case 'SubLink': {
        if (!SUBLINKS.has(String(fields.subLinkType)))
          sqlFail('Конструкция SQL не поддерживается', at)
        this.expr(fields.testexpr, scope, inner, at)
        if (fields.operName !== undefined) this.operator(fields.operName, 'AEXPR_OP', at)
        const [, sub] = this.nodeSelect(fields.subselect, at)
        this.sublinkOutputs.set(fields, this.select(sub, scope, at))
        return
      }
      case 'A_Indirection':
        this.expr(fields.arg, scope, inner, at)
        for (const item of list(fields.indirection)) {
          const [kind, part] = this.node(item, at)
          if (kind === 'A_Indices') {
            this.expr(part.lidx, scope, INPUT, at)
            this.expr(part.uidx, scope, INPUT, at)
          } else if (kind !== 'String' && kind !== 'A_Star') {
            sqlFail('Конструкция SQL не поддерживается', at)
          }
        }
        return
      case 'CollateClause': {
        const names = this.strings(fields.collname, at)
        if (names.length > 2 || (names.length === 2 && names[0] !== 'pg_catalog')) {
          sqlFail(`Правило сортировки «${names.join('.')}» недоступно`, at)
        }
        this.expr(fields.arg, scope, inner, at)
        return
      }
      case 'JsonIsPredicate':
        if (fields.format !== undefined) {
          if (!isObj(fields.format)) sqlFail('Конструкция SQL не поддерживается', at)
          this.check('JsonFormat', fields.format, at)
        }
        this.expr(fields.expr, scope, inner, at)
        return
      case 'NamedArgExpr':
        this.expr(fields.arg, scope, inner, at)
        return
      default:
        sqlFail(UNSUPPORTED[type] ?? `Конструкция SQL «${type}» не поддерживается`, at)
    }
  }

  protected funcCall(fields: Obj, scope: Scope, at: number): void {
    const names = this.strings(fields.funcname, at)
    const name = names[names.length - 1] ?? ''
    const shown = names.join('.')
    if (isDeniedFunction(name)) sqlFail(`Функция «${shown}» запрещена`, at)
    if (names.length > 2 || (names.length === 2 && names[0] !== 'pg_catalog')) {
      sqlFail(`Функция «${shown}» недоступна: функции других схем запрещены`, at)
    }
    if (!isAllowedFunction(name)) {
      const lower = name.toLowerCase()
      sqlFail(
        `Функция «${shown}» недоступна в SQL-лаборатории`,
        at,
        lower !== name && isAllowedFunction(lower)
          ? `Имя функции пишется без кавычек: ${lower}`
          : FUNCTION_HINT,
      )
    }
    if (VOLATILE_FUNCTIONS.has(name)) {
      if (['random', 'gen_random_uuid'].includes(name)) this.volatile = true
      else this.usesTime = true
    }
    for (const arg of list(fields.args)) this.expr(arg, scope, INPUT, at)
    for (const item of list(fields.agg_order)) this.sortBy(item, scope, null, at)
    this.expr(fields.agg_filter, scope, INPUT, at)
    if (fields.over !== undefined) {
      if (!isObj(fields.over)) sqlFail('Конструкция SQL не поддерживается', at)
      this.windowDef(fields.over, scope, at)
    }
  }

  protected operator(value: unknown, kind: string, at: number): void {
    const names = this.strings(value, at)
    const name = names[0] ?? ''
    if (BETWEEN_KINDS.has(kind)) {
      if (names.length !== 1 || !/^(NOT )?BETWEEN( SYMMETRIC)?$/.test(name)) {
        sqlFail('Конструкция SQL не поддерживается', at)
      }
      return
    }
    if (names.length !== 1 || !OPERATOR.test(name)) {
      sqlFail(
        `Оператор «${names.join('.')}» недоступен: OPERATOR(схема.оператор) не поддерживается`,
        at,
      )
    }
  }

  protected typeName(value: unknown, at: number): void {
    if (!isObj(value)) sqlFail('Конструкция SQL не поддерживается', at)
    if (value.pct_type !== undefined || value.setof !== undefined) {
      sqlFail('%TYPE и SETOF не поддерживаются', at)
    }
    this.check('TypeName', value, at)
    const pos = this.at(value.location, at)
    const names = this.strings(value.names, pos)
    const shown =
      names.length === 2 && names[0] === 'pg_catalog' ? (names[1] as string) : names.join('.')
    const name =
      names.length === 1
        ? names[0]
        : names.length === 2 && names[0] === 'pg_catalog'
          ? names[1]
          : null
    if (!name || !isAllowedType(name))
      sqlFail(`Приведение к типу «${shown}» запрещено`, pos, TYPE_HINT)
    for (const modifier of list(value.typmods)) {
      const [kind, fields] = this.node(modifier, pos)
      // geometry(Point, 4326): имя подтипа разборщик отдаёт ссылкой на столбец
      if (kind === 'ColumnRef' && this.columnParts(fields, pos).length === 1) continue
      if (kind !== 'A_Const') sqlFail('Модификатор типа: только константы', pos)
    }
    for (const bound of list(value.arrayBounds)) {
      const [kind] = this.node(bound, pos)
      if (kind !== 'Integer') sqlFail('Конструкция SQL не поддерживается', pos)
    }
  }

  protected paramRef(fields: Obj, at: number): void {
    const placeholder = this.placeholders.get(at)
    if (!placeholder || fields.number !== placeholder.marker) {
      sqlFail('Параметры записываются как {{имя}}', at, 'Позиционные параметры $1, $2… недоступны')
    }
    if (!this.seen.has(placeholder.marker)) {
      this.seen.add(placeholder.marker)
      this.params.push(placeholder)
    }
  }

  /** Каждый `{{параметр}}` должен стать параметром запроса, а не частью имени. */
  checkPlaceholders(placeholders: readonly Placeholder[]): void {
    for (const placeholder of placeholders) {
      if (!this.seen.has(placeholder.marker)) {
        sqlFail(
          `Параметр {{${placeholder.name}}} не распознан`,
          placeholder.start,
          'Отделите параметр пробелами или скобками от соседних слов',
        )
      }
    }
  }
}
