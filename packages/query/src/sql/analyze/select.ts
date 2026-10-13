import { quoteIdent } from '../../ident.js'
import { readIdentifier, sqlFail } from '../text.js'
import { ExprAnalyzer } from './expr.js'
import { NODE_FIELDS, STATEMENTS, TAIL_FIELDS, UNSUPPORTED } from './grammar.js'
import {
  type CteBinding,
  type FromItem,
  INPUT,
  isObj,
  list,
  type Obj,
  type Output,
  renameOutputs,
  Scope,
  SYSTEM_NAMES,
} from './model.js'

const CTE_PREFIX = '__kchs_cte_'

/**
 * Слой 4: операторы — SELECT, объединения, VALUES, WITH, FROM и соединения, список
 * выборки. Каждая ссылка на таблицу переписывается: на датасет или на служебное имя CTE.
 */
export class Analyzer extends ExprAnalyzer {
  statement(stmt: unknown, pos: number): Output[] {
    if (isObj(stmt)) {
      const type = Object.keys(stmt)[0] ?? ''
      if (type !== 'SelectStmt') {
        const message =
          STATEMENTS[type] ??
          (/^(Create|Alter|Drop|Rename|Comment|Refresh|Reindex|Cluster|Security|Import)/.test(type)
            ? 'Изменение структуры базы запрещено: доступны только запросы на чтение'
            : 'Доступны только запросы на чтение: SELECT, WITH, VALUES')
        return sqlFail(message, pos)
      }
    }
    const [, fields] = this.nodeSelect(stmt, pos)
    return this.select(fields, null, pos)
  }

  /** Узел SELECT с понятными причинами отказа для INTO и FOR UPDATE. */
  protected nodeSelect(value: unknown, pos: number): [string, Obj] {
    if (isObj(value) && isObj(value.SelectStmt)) this.selectClauses(value.SelectStmt, pos)
    if (isObj(value) && !isObj(value.SelectStmt)) {
      const type = Object.keys(value)[0] ?? ''
      if (['InsertStmt', 'UpdateStmt', 'DeleteStmt', 'MergeStmt'].includes(type)) {
        return sqlFail(STATEMENTS[type] as string, pos)
      }
    }
    return this.node(value, pos)
  }

  protected selectClauses(stmt: Obj, pos: number): void {
    if (stmt.intoClause !== undefined) {
      const into = stmt.intoClause as Obj
      const at = this.at(isObj(into.rel) ? into.rel.location : undefined, pos)
      sqlFail('SELECT INTO запрещён: запрос не создаёт таблиц', at)
    }
    if (stmt.lockingClause !== undefined) {
      sqlFail('Блокировки строк (FOR UPDATE, FOR SHARE) запрещены', pos)
    }
  }

  protected select(stmt: Obj, parent: Scope | null, pos: number): Output[] {
    this.selectClauses(stmt, pos)
    this.check('SelectStmt', stmt, pos)
    const scope = new Scope(parent)
    if (stmt.withClause !== undefined) this.withClause(stmt.withClause, scope, pos)
    const op = stmt.op ?? 'SETOP_NONE'
    if (op !== 'SETOP_NONE') {
      if (!['SETOP_UNION', 'SETOP_INTERSECT', 'SETOP_EXCEPT'].includes(String(op))) {
        return sqlFail('Конструкция SQL не поддерживается', pos)
      }
      // Узел объединения: только ветви и хвост — других полей анализатор не обходит
      this.only(stmt, [...TAIL_FIELDS, 'all', 'larg', 'rarg'], pos)
      if (!isObj(stmt.larg) || !isObj(stmt.rarg))
        return sqlFail('Конструкция SQL не поддерживается', pos)
      const left = this.select(stmt.larg, scope, pos)
      this.select(stmt.rarg, scope, pos)
      this.tail(stmt, new Scope(scope), left, pos)
      return left
    }
    if (stmt.valuesLists !== undefined) {
      this.only(stmt, [...TAIL_FIELDS, 'valuesLists'], pos)
      let width = 0
      for (const row of list(stmt.valuesLists)) {
        const [type, fields] = this.node(row, pos)
        if (type !== 'List') return sqlFail('Конструкция SQL не поддерживается', pos)
        const items = list(fields.items)
        width = Math.max(width, items.length)
        for (const item of items) this.expr(item, scope, INPUT, pos)
      }
      const outputs: Output[] = Array.from({ length: width }, (_, index) => ({
        kind: 'column',
        name: `column${index + 1}`,
        field: null,
      }))
      this.tail(stmt, new Scope(scope), outputs, pos)
      return outputs
    }

    this.only(
      stmt,
      (NODE_FIELDS.SelectStmt as readonly string[]).filter(
        (key) => !['all', 'larg', 'rarg', 'valuesLists'].includes(key),
      ),
      pos,
    )
    const targets = list(stmt.targetList)
    const tableSyntax = targets.length === 1 && this.isTableSyntax(targets[0])
    if (tableSyntax) sqlFail('Вместо «TABLE имя» напишите «SELECT * FROM имя»', pos)

    let usingJoins = false
    for (const item of list(stmt.fromClause)) {
      const added = this.fromItem(item, scope, scope.items, pos)
      scope.items.push(...added.items)
      usingJoins ||= added.using
    }
    this.expr(stmt.whereClause, scope, INPUT, pos)
    const outputs = this.targetList(targets, scope, usingJoins, pos)
    for (const item of list(stmt.groupClause)) this.groupItem(item, scope, outputs, pos)
    this.expr(stmt.havingClause, scope, INPUT, pos)
    for (const item of list(stmt.windowClause)) {
      const [type, fields] = this.node(item, pos)
      if (type !== 'WindowDef') return sqlFail('Конструкция SQL не поддерживается', pos)
      this.windowDef(fields, scope, pos)
    }
    for (const item of list(stmt.distinctClause)) {
      // Пустой узел — DISTINCT без ON
      if (isObj(item) && Object.keys(item).length === 0) continue
      this.orderItem(item, scope, outputs, 'order', pos)
    }
    this.tail(stmt, scope, outputs, pos, true)
    return outputs
  }

  /** ORDER BY, LIMIT, OFFSET: у объединений и VALUES — по именам результата. */
  protected tail(stmt: Obj, scope: Scope, outputs: Output[], pos: number, simple = false): void {
    if (!simple) {
      scope.items.push({ kind: 'relation', ref: null, columns: outputs })
    }
    for (const item of list(stmt.sortClause)) this.sortBy(item, scope, outputs, pos)
    this.expr(stmt.limitCount, scope, INPUT, pos)
    this.expr(stmt.limitOffset, scope, INPUT, pos)
    const option = stmt.limitOption
    if (
      option !== undefined &&
      !['LIMIT_OPTION_DEFAULT', 'LIMIT_OPTION_COUNT', 'LIMIT_OPTION_WITH_TIES'].includes(
        String(option),
      )
    ) {
      sqlFail('Конструкция SQL не поддерживается', pos)
    }
  }

  /** `TABLE имя` — звёздочка без позиции в тексте. */
  protected isTableSyntax(target: unknown): boolean {
    if (!isObj(target) || !isObj(target.ResTarget)) return false
    const value = target.ResTarget.val
    if (!isObj(value) || !isObj(value.ColumnRef)) return false
    return value.ColumnRef.location === -1 || value.ColumnRef.location === undefined
  }

  protected withClause(value: unknown, scope: Scope, pos: number): void {
    if (!isObj(value)) sqlFail('Конструкция SQL не поддерживается', pos)
    this.check('WithClause', value, pos)
    const recursive = value.recursive === true
    const entries = list(value.ctes).map((item) => {
      const [type, fields] = this.node(item, pos)
      if (type !== 'CommonTableExpr') return sqlFail('Конструкция SQL не поддерживается', pos)
      return fields
    })
    const bindings: CteBinding[] = []
    for (const cte of entries) {
      const at = this.at(cte.location, pos)
      const name = String(cte.ctename ?? '')
      if (bindings.some((binding) => binding.name === name)) {
        sqlFail(`Имя «${name}» в WITH повторяется`, at)
      }
      const generated = `${CTE_PREFIX}${this.cteCount++}`
      const token = this.identifierToken(at, name, 'имя в WITH')
      this.edits.push({ start: token.start, end: token.end, text: quoteIdent(generated) })
      const aliases = cte.aliascolnames === undefined ? null : this.strings(cte.aliascolnames, at)
      bindings.push({
        name,
        generated,
        columns: aliases
          ? aliases.map((alias) => ({ kind: 'column', name: alias, field: null }))
          : null,
      })
    }
    if (recursive) scope.ctes.push(...bindings)
    entries.forEach((cte, index) => {
      const at = this.at(cte.location, pos)
      const binding = bindings[index] as CteBinding
      const visible = recursive ? scope.ctes : bindings.slice(0, index)
      const [, body] = this.nodeSelect(cte.ctequery, at)
      const outputs = this.select(body, new Scope(scope.parent, visible), at)
      if (binding.columns === null) binding.columns = outputs
      else binding.columns = [...binding.columns, ...outputs.slice(binding.columns.length)]
      if (!recursive) scope.ctes.push(binding)
    })
  }

  /** Элемент FROM → элементы области видимости; `using` — соединение USING/NATURAL. */
  protected fromItem(
    value: unknown,
    scope: Scope,
    visible: readonly FromItem[],
    pos: number,
  ): { items: FromItem[]; using: boolean } {
    if (isObj(value) && isObj(value.RangeVar))
      return { items: [this.rangeVar(value.RangeVar, scope, pos)], using: false }
    const [type, fields] = this.node(value, pos)
    switch (type) {
      case 'RangeSubselect': {
        const lateral = fields.lateral === true
        const [, sub] = this.nodeSelect(fields.subquery, pos)
        const outputs = this.select(
          sub,
          new Scope(scope.parent, scope.ctes, lateral ? [...visible] : []),
          pos,
        )
        const alias = this.alias(fields.alias, pos)
        return {
          items: [
            {
              kind: 'relation',
              ref: alias?.name ?? null,
              columns: renameOutputs(outputs, alias?.columns),
            },
          ],
          using: false,
        }
      }
      case 'RangeFunction':
        return { items: [this.rangeFunction(fields, scope, visible, pos)], using: false }
      case 'JoinExpr': {
        const left = this.fromItem(fields.larg, scope, visible, pos)
        const right = this.fromItem(fields.rarg, scope, [...visible, ...left.items], pos)
        const children = [...left.items, ...right.items]
        this.expr(fields.quals, new Scope(scope.parent, scope.ctes, children), INPUT, pos)
        const using = this.strings(fields.usingClause, pos)
        for (const name of using) this.usingColumn(name, left.items, right.items, pos)
        const items: FromItem[] = []
        const alias = this.alias(fields.alias, pos)
        if (alias) {
          if (alias.columns) sqlFail('Переименование столбцов соединения не поддерживается', pos)
          items.push({ kind: 'join', ref: alias.name, children })
        } else {
          items.push(...children)
        }
        const usingAlias = this.alias(fields.join_using_alias, pos)
        if (usingAlias) {
          items.push({
            kind: 'relation',
            ref: usingAlias.name,
            columns: using.map((name) => ({ kind: 'column', name, field: null })),
          })
        }
        return {
          items,
          using: left.using || right.using || using.length > 0 || fields.isNatural === true,
        }
      }
      default:
        return sqlFail(UNSUPPORTED[type] ?? `Конструкция SQL «${type}» не поддерживается`, pos)
    }
  }

  protected rangeVar(fields: Obj, scope: Scope, pos: number): FromItem {
    const at = this.at(fields.location, pos)
    const schema = fields.catalogname ?? fields.schemaname
    if (schema !== undefined) {
      return sqlFail(
        `Обращение к схеме «${String(schema)}» запрещено: в запросе доступны только датасеты по названию`,
        at,
        'Например: SELECT * FROM "Происшествия"',
      )
    }
    this.check('RangeVar', fields, at)
    if (fields.inh !== true) sqlFail('ONLY не поддерживается', at)
    const name = String(fields.relname ?? '')
    const alias = this.alias(fields.alias, at)
    const token = this.identifierToken(at, name, 'имя таблицы')
    const ref = alias?.name ?? name

    const cte = scope.cte(name)
    if (cte) {
      this.edits.push({
        start: token.start,
        end: token.end,
        text: alias
          ? quoteIdent(cte.generated)
          : `${quoteIdent(cte.generated)} AS ${quoteIdent(name)}`,
      })
      return { kind: 'relation', ref, columns: renameOutputs(cte.columns, alias?.columns) }
    }
    if (!this.tables.includes(name)) this.tables.push(name)
    if (!this.catalog) return { kind: 'relation', ref, columns: null }

    const dataset = this.catalog.find(name, at)
    if (!dataset) {
      const similar = this.catalog.similar(name)
      return sqlFail(
        `Нет датасета «${name}» или нет доступа к нему`,
        at,
        similar.length ? `Возможно, имелось в виду: ${similar.join(', ')}` : undefined,
      )
    }
    if (alias?.columns) {
      sqlFail(
        'Переименование столбцов датасета в алиасе не поддерживается',
        at,
        'Задайте имена через AS в SELECT',
      )
    }
    let use = this.datasets.get(dataset.id)
    if (!use) {
      use = { dataset, refs: [] }
      this.datasets.set(dataset.id, use)
    }
    use.refs.push({ start: token.start, end: token.end, alias: alias ? null : name })
    return { kind: 'dataset', ref, binding: this.binding(dataset) }
  }

  protected rangeFunction(
    fields: Obj,
    scope: Scope,
    visible: readonly FromItem[],
    pos: number,
  ): FromItem {
    // Функции во FROM видят предыдущие элементы (неявный LATERAL)
    const inner = new Scope(scope.parent, scope.ctes, [...visible])
    const functions = list(fields.functions)
    let single: string | null = null
    const columns: Output[] = []
    for (const entry of functions) {
      const [type, pair] = this.node(entry, pos)
      if (type !== 'List') return sqlFail('Конструкция SQL не поддерживается', pos)
      const [call, definitions] = list(pair.items)
      this.expr(call, inner, INPUT, pos)
      if (functions.length === 1 && isObj(call) && isObj(call.FuncCall)) {
        const names = this.strings(call.FuncCall.funcname, pos)
        single = names[names.length - 1] ?? null
      }
      if (isObj(definitions) && Object.keys(definitions).length > 0) {
        const [listType, defs] = this.node(definitions, pos)
        if (listType !== 'List') return sqlFail('Конструкция SQL не поддерживается', pos)
        columns.push(...this.columnDefs(defs.items, pos))
      }
    }
    columns.push(...this.columnDefs(fields.coldeflist, pos))
    const alias = this.alias(fields.alias, pos)
    return {
      kind: 'relation',
      ref: alias?.name ?? single,
      columns: alias?.columns
        ? alias.columns.map((name) => ({ kind: 'column', name, field: null }))
        : columns.length
          ? columns
          : null,
    }
  }

  protected columnDefs(value: unknown, pos: number): Output[] {
    return list(value).map((item) => {
      const [type, fields] = this.node(item, pos)
      if (type !== 'ColumnDef') return sqlFail('Конструкция SQL не поддерживается', pos)
      const at = this.at(fields.location, pos)
      this.typeName(fields.typeName, at)
      return { kind: 'column', name: String(fields.colname ?? ''), field: null }
    })
  }

  protected alias(value: unknown, pos: number): { name: string; columns: string[] | null } | null {
    if (value === undefined) return null
    if (!isObj(value)) return sqlFail('Конструкция SQL не поддерживается', pos)
    this.check('Alias', value, pos)
    return {
      name: String(value.aliasname ?? ''),
      columns: value.colnames === undefined ? null : this.strings(value.colnames, pos),
    }
  }

  /** Имя в USING: у датасетов — ключ поля (у имён USING нет позиций для замены подписи). */
  protected usingColumn(
    name: string,
    left: readonly FromItem[],
    right: readonly FromItem[],
    pos: number,
  ): void {
    if (SYSTEM_NAMES.has(name)) this.systemColumns.add(name)
    for (const side of [left, right]) {
      const found = this.lookupIn(side, name)
      for (const match of found.fields) {
        if (match.lookup.kind === 'field' && match.lookup.viaLabel) {
          sqlFail(
            `В USING укажите ключ поля «${match.lookup.field.key}», а не подпись «${name}»`,
            pos,
          )
        }
      }
      const problem = found.problems[0]
      if (problem && found.fields.length === 0 && found.others === 0) this.problem(problem, pos)
    }
  }

  protected identifierToken(
    at: number,
    name: string,
    what: string,
  ): { start: number; end: number } {
    const token = readIdentifier(this.text, at)
    if (!token) {
      return sqlFail(`Не удалось прочитать ${what}: используйте обычные двойные кавычки`, at)
    }
    if (token.value !== name) sqlFail(`Не удалось прочитать ${what} «${name}»`, at)
    return token
  }

  protected targetList(
    targets: unknown[],
    scope: Scope,
    usingJoins: boolean,
    pos: number,
  ): Output[] {
    const outputs: Output[] = []
    for (const target of targets) {
      const [type, fields] = this.node(target, pos)
      if (type !== 'ResTarget') return sqlFail('Конструкция SQL не поддерживается', pos)
      const at = this.at(fields.location, pos)
      const value = fields.val
      const name = typeof fields.name === 'string' ? fields.name : null
      if (isObj(value) && isObj(value.ColumnRef)) {
        const [, ref] = this.node(value, at)
        const star = this.star(ref, scope, usingJoins, at)
        if (star) {
          outputs.push(...star)
          continue
        }
        const field = this.columnRef(
          ref,
          scope,
          { ...INPUT, bareTarget: name === null },
          this.at(ref.location, at),
        )
        outputs.push({ kind: 'column', name: name ?? this.figureName(value), field })
        continue
      }
      this.expr(value, scope, INPUT, at)
      outputs.push({ kind: 'column', name: name ?? this.figureName(value), field: null })
    }
    return outputs
  }

  /** `*` и `алиас.*`: столбцы для имён результата. */
  protected star(ref: Obj, scope: Scope, usingJoins: boolean, pos: number): Output[] | null {
    const parts = this.columnParts(ref, pos)
    if (parts[parts.length - 1] !== null) return null
    const expand = (item: FromItem): Output[] => {
      if (item.kind === 'dataset') return [{ kind: 'dataset', datasetId: item.binding.dataset.id }]
      if (item.kind === 'join') return item.children.flatMap(expand)
      return item.columns ? [...item.columns] : [{ kind: 'unknown' }]
    }
    if (parts.length === 1) {
      // USING и NATURAL сливают одноимённые столбцы — порядок и состав известны только Postgres
      if (usingJoins) return [{ kind: 'unknown' }]
      return scope.items.flatMap(expand)
    }
    const qualifier = parts[0]
    for (let current: Scope | null = scope; current; current = current.parent) {
      const item = current.items.find((candidate) => candidate.ref === qualifier)
      if (item) return expand(item)
    }
    return [{ kind: 'unknown' }]
  }
}
