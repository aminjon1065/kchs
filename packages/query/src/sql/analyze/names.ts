import { similarNames } from '../../compiler/scope.js'
import { quoteIdent } from '../../ident.js'
import { TIME_VALUE_NAMES } from '../allowlist.js'
import { readIdentifierChain, sqlFail } from '../text.js'
import {
  type ColumnLookup,
  type DatasetBinding,
  type ExprCtx,
  type FieldLookup,
  type FieldRef,
  type Found,
  type FromItem,
  isObj,
  list,
  type Obj,
  type OutputMatch,
  outputsLookup,
  type Scope,
  SYSTEM_NAMES,
} from './model.js'
import { TreeReader } from './reader.js'

/** Слой 2: ссылки на поля (подпись → ключ, скрытые поля) и имена столбцов результата. */
export abstract class NameResolver extends TreeReader {
  /** Части ссылки на поле; null — звёздочка (имя `"*"` в кавычках — обычная строка). */
  protected columnParts(fields: Obj, pos: number): Array<string | null> {
    const parts = list(fields.fields).map((item) => {
      const [type, part] = this.node(item, pos)
      if (type === 'A_Star') return null
      if (type === 'String' && typeof part.sval === 'string') return part.sval
      return sqlFail('Конструкция SQL не поддерживается', pos)
    })
    if (parts.length === 0 || parts.slice(0, -1).includes(null)) {
      sqlFail('Конструкция SQL не поддерживается', pos)
    }
    return parts
  }

  /** Ссылка на поле: подпись → ключ, скрытое поле — отказ. Возвращает поле датасета, если нашлось. */
  protected columnRef(fields: Obj, scope: Scope, ctx: ExprCtx, at: number): FieldRef | null {
    const parts = this.columnParts(fields, at)
    if (parts.length > 2) {
      sqlFail('Ссылка на поле: «поле» или «таблица.поле»', at, 'Схемы и вложенные имена недоступны')
    }
    const name = parts[parts.length - 1]
    if (name === null || name === undefined) return null
    if (SYSTEM_NAMES.has(name)) this.systemColumns.add(name)
    const qualifier = parts.length === 2 ? parts[0] : null
    if (qualifier) return this.qualified(qualifier, name, fields, scope, ctx, at)
    return this.unqualified(name, fields, scope, ctx, at)
  }

  protected unqualified(
    name: string,
    ref: Obj,
    scope: Scope,
    ctx: ExprCtx,
    at: number,
  ): FieldRef | null {
    const outputs = ctx.outputs
    if (ctx.names === 'order' && outputs) {
      // Имя результата важнее поля; подпись за звёздочкой разрешится как поле ниже
      const result = outputsLookup(outputs, this.bindings, name)
      if (typeof result === 'object' && 'rename' in result && result.rename === null) {
        return result.field
      }
    }
    for (let current: Scope | null = scope; current; current = current.parent) {
      const found = this.lookupIn(current.items, name)
      const total = found.fields.length + found.others
      if (total === 1) {
        const match = found.fields[0]
        if (match) return this.apply(match.item.binding, match.lookup, ref, 1, name, ctx, at)
        return this.relationColumn(found.other, ref, 1, name, ctx, at)
      }
      if (total > 1) {
        if (found.others === 0) {
          const refs = found.fields.map((match) => `${match.item.ref}.${name}`)
          sqlFail(`Поле «${name}» неоднозначно`, at, `Укажите таблицу: ${refs.join(' или ')}`)
        }
        return null
      }
      const problem = found.problems[0]
      if (problem) this.problem(problem, at)
      if (found.maybe) return null
      // Имя таблицы без поля — ссылка на строку целиком
      if (current.items.some((item) => item.ref === name)) return null
    }
    if (
      outputs &&
      ctx.names !== 'input' &&
      outputsLookup(outputs, this.bindings, name) !== 'none'
    ) {
      return null
    }
    if (!this.catalog) return null
    const names = scope.items.flatMap((item) => this.itemNames(item))
    const similar = similarNames(names, name)
    return sqlFail(
      `Нет поля «${name}»`,
      at,
      similar.length ? `Возможно, имелось в виду: ${similar.join(', ')}` : undefined,
    )
  }

  protected qualified(
    qualifier: string,
    name: string,
    ref: Obj,
    scope: Scope,
    ctx: ExprCtx,
    at: number,
  ): FieldRef | null {
    for (let current: Scope | null = scope; current; current = current.parent) {
      const item = current.items.find((candidate) => candidate.ref === qualifier)
      if (!item) continue
      if (item.kind === 'relation') {
        const result = outputsLookup(item.columns, this.bindings, name)
        if (typeof result !== 'object') return null
        if ('problem' in result) return this.problem(result.problem, at)
        return this.relationColumn(result, ref, 2, name, ctx, at)
      }
      const found =
        item.kind === 'dataset' ? this.lookupIn([item], name) : this.lookupIn(item.children, name)
      const match = found.fields[0]
      if (match && found.fields.length === 1 && found.others === 0) {
        return this.apply(match.item.binding, match.lookup, ref, 2, name, ctx, at)
      }
      if (found.fields.length > 1) {
        sqlFail(`Поле «${qualifier}.${name}» неоднозначно`, at)
      }
      const problem = found.problems[0]
      if (problem && found.others === 0) this.problem(problem, at)
      if (found.maybe || found.others > 0 || !this.catalog) return null
      const similar = similarNames(this.itemNames(item), name)
      return sqlFail(
        `Нет поля «${qualifier}.${name}»`,
        at,
        similar.length ? `Возможно, имелось в виду: ${similar.join(', ')}` : undefined,
      )
    }
    // Не таблица — поле составного значения или ошибка, которую покажет Postgres
    return null
  }

  protected itemNames(item: FromItem): string[] {
    if (item.kind === 'dataset') return item.binding.names()
    if (item.kind === 'join') return item.children.flatMap((child) => this.itemNames(child))
    return (item.columns ?? []).flatMap((column) =>
      column.kind === 'column' && column.name ? [column.name] : [],
    )
  }

  protected lookupIn(items: readonly FromItem[], name: string): Found {
    const found: Found = { fields: [], problems: [], others: 0, other: null, maybe: false }
    const visit = (item: FromItem) => {
      if (item.kind === 'join') {
        item.children.forEach(visit)
        return
      }
      if (item.kind === 'dataset') {
        const lookup = item.binding.lookup(name)
        if (!lookup) return
        if (lookup.kind === 'field' || lookup.kind === 'system') found.fields.push({ item, lookup })
        else found.problems.push(lookup)
        return
      }
      const result = outputsLookup(item.columns, this.bindings, name)
      if (result === 'maybe') found.maybe = true
      else if (result === 'none') return
      else if ('problem' in result) found.problems.push(result.problem)
      else {
        found.others++
        found.other = result
      }
    }
    items.forEach(visit)
    return found
  }

  protected problem(problem: FieldLookup, at: number): never {
    switch (problem.kind) {
      case 'hidden':
        return sqlFail(`Нет доступа к полю «${problem.name}»`, at)
      case 'unavailable':
        return sqlFail(
          `Поле «${problem.name}» вычисляемое — в запросах к данным оно пока недоступно`,
          at,
        )
      case 'ambiguous':
        return sqlFail(
          `Подпись «${problem.name}» у нескольких полей`,
          at,
          `Укажите ключ поля: ${problem.keys.join(', ')}`,
        )
      default:
        return sqlFail('Конструкция SQL не поддерживается', at)
    }
  }

  /** Подпись поля → ключ (правка текста); голое поле в списке выборки сохраняет имя. */
  protected apply(
    binding: DatasetBinding,
    lookup: ColumnLookup,
    ref: Obj,
    count: number,
    name: string,
    ctx: ExprCtx,
    at: number,
  ): FieldRef {
    const datasetId = binding.dataset.id
    if (lookup.kind === 'system') return { datasetId, column: lookup.name }
    const { field, viaLabel } = lookup
    if (viaLabel) this.rename(field.key, ref, count, name, ctx, at)
    return { datasetId, column: field.key }
  }

  /** Столбец CTE или подзапроса; подпись за звёздочкой заменяется ключом. */
  protected relationColumn(
    match: OutputMatch | null,
    ref: Obj,
    count: number,
    name: string,
    ctx: ExprCtx,
    at: number,
  ): FieldRef | null {
    if (!match) return null
    if (match.rename !== null) this.rename(match.rename, ref, count, name, ctx, at)
    return match.field
  }

  /** Правка текста: последнее имя ссылки → ключ; голое поле выборки сохраняет имя через AS. */
  protected rename(
    key: string,
    ref: Obj,
    count: number,
    name: string,
    ctx: ExprCtx,
    at: number,
  ): void {
    const tokens = readIdentifierChain(this.text, at, count)
    const token = tokens?.[count - 1]
    if (!token || token.value !== name) {
      sqlFail(`Не удалось прочитать имя поля «${name}»: используйте обычные двойные кавычки`, at)
    }
    this.edits.push({ start: token.start, end: token.end, text: quoteIdent(key) })
    if (ctx.bareTarget) {
      this.edits.push({ start: token.end, end: token.end, text: ` AS ${quoteIdent(name)}` })
    } else {
      this.renamed.set(ref, key)
    }
  }

  protected figureName(value: unknown): string | null {
    const [name] = this.figure(value)
    return name ?? '?column?'
  }

  /** Имя и «сила» имени: 2 — имя столбца или функции, 1 — служебное, 0 — нет. */
  protected figure(value: unknown): [string | null, number] {
    if (!isObj(value)) return [null, 0]
    const type = Object.keys(value)[0] ?? ''
    const fields = value[type]
    if (!isObj(fields)) return [null, 0]
    switch (type) {
      case 'ColumnRef': {
        const parts = list(fields.fields).flatMap((item) =>
          isObj(item) && isObj(item.String) && typeof item.String.sval === 'string'
            ? [item.String.sval]
            : [],
        )
        const last = parts[parts.length - 1]
        if (last === undefined) return [null, 0]
        return [this.renamed.get(fields) ?? last, 2]
      }
      case 'A_Indirection': {
        const parts = list(fields.indirection).flatMap((item) =>
          isObj(item) && isObj(item.String) && typeof item.String.sval === 'string'
            ? [item.String.sval]
            : [],
        )
        const last = parts[parts.length - 1]
        return last === undefined ? this.figure(fields.arg) : [last, 2]
      }
      case 'FuncCall': {
        const names = list(fields.funcname).flatMap((item) =>
          isObj(item) && isObj(item.String) && typeof item.String.sval === 'string'
            ? [item.String.sval]
            : [],
        )
        return [names[names.length - 1] ?? null, 2]
      }
      case 'A_Expr':
        return fields.kind === 'AEXPR_NULLIF' ? ['nullif', 2] : [null, 0]
      case 'TypeCast': {
        const inner = this.figure(fields.arg)
        if (inner[1] > 1) return inner
        const names = isObj(fields.typeName) ? list(fields.typeName.names) : []
        const last = names[names.length - 1]
        return isObj(last) && isObj(last.String) && typeof last.String.sval === 'string'
          ? [last.String.sval, 1]
          : inner
      }
      case 'CollateClause':
        return this.figure(fields.arg)
      case 'GroupingFunc':
        return ['grouping', 2]
      case 'SubLink':
        if (fields.subLinkType === 'EXISTS_SUBLINK') return ['exists', 2]
        if (fields.subLinkType === 'ARRAY_SUBLINK') return ['array', 2]
        if (fields.subLinkType === 'EXPR_SUBLINK') {
          const first = this.sublinkOutputs.get(fields)?.[0]
          return first?.kind === 'column' && first.name !== null ? [first.name, 2] : [null, 0]
        }
        return [null, 0]
      case 'CaseExpr': {
        const inner = this.figure(fields.defresult)
        return inner[1] > 1 ? inner : ['case', 1]
      }
      case 'A_ArrayExpr':
        return ['array', 2]
      case 'RowExpr':
        return ['row', 2]
      case 'CoalesceExpr':
        return ['coalesce', 2]
      case 'MinMaxExpr':
        return [fields.op === 'IS_LEAST' ? 'least' : 'greatest', 2]
      case 'SQLValueFunction':
        return [TIME_VALUE_NAMES[String(fields.op)] ?? null, 2]
      default:
        return [null, 0]
    }
  }
}
