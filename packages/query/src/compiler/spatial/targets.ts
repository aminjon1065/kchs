import { FilterNode, type QuerySource, SYSTEM_DATASETS, TERRITORY_LEVELS } from '@kchs/contracts'
import { fail, type IssuePath } from '../../errors.js'
import { compileFilter, geometryLiteral } from '../filter.js'
import { columnSql, type Relation, resolveColumn } from '../scope.js'
import {
  ALIAS,
  allowedKeys,
  directoryColumn,
  geometryColumn,
  isRecord,
  isSystemName,
  MAX_TERRITORIES,
  type Predicate,
  type Target,
  TERRITORIES_DATASET,
  UUID,
} from './defs.js'
import { SpatialRelation } from './relation.js'

/** Слой 2: цель операции — литерал, другой источник или территории справочника. */
export abstract class SpatialTargets extends SpatialRelation {
  /** Цель операции: геометрия-значение или отношение (датасет, запрос, территории). */
  protected target(allowLiteral: boolean): Target {
    const path = [...this.path, 'target']
    const raw = this.step.target
    if (!isRecord(raw)) {
      return fail(path, 'Цель — датасет, сохранённый запрос, территории или геометрия GeoJSON')
    }
    // Геометрия GeoJSON без обёртки
    if (raw.kind === undefined && typeof raw.type === 'string') {
      return this.literal(raw, path, allowLiteral)
    }
    switch (raw.kind) {
      case 'geometry':
        allowedKeys(raw, ['kind', 'geometry'], path)
        return this.literal(raw.geometry, [...path, 'geometry'], allowLiteral)
      case 'dataset':
      case 'query':
      case 'system':
        return this.sourceTarget(raw, path)
      case 'territory':
        return this.territoryTarget(raw, path)
      default:
        return fail([...path, 'kind'], 'Вид цели — dataset, query, system, territory или geometry')
    }
  }

  protected literal(value: unknown, path: IssuePath, allowed: boolean): Target {
    if (!allowed) {
      fail(path, `Для операции «${this.step.op}» цель — датасет, сохранённый запрос или территории`)
    }
    return { kind: 'literal', sql: geometryLiteral(this.state, value, path) }
  }

  /** Датасет, сохранённый запрос или системный датасет — с политиками, как в соединении. */
  protected sourceTarget(raw: Record<string, unknown>, path: IssuePath): Target {
    const kind = raw.kind as 'dataset' | 'query' | 'system'
    allowedKeys(raw, ['kind', kind === 'system' ? 'name' : 'id', 'alias', 'field', 'filter'], path)
    const alias = raw.alias
    if (
      alias !== undefined &&
      (typeof alias !== 'string' || !ALIAS.test(alias) || alias.length > 32)
    ) {
      fail([...path, 'alias'], 'Алиас: латиница, цифры, подчёркивание (до 32 символов)')
    }
    const withAlias = typeof alias === 'string' ? { alias } : {}
    let source: QuerySource
    if (kind === 'system') {
      if (!isSystemName(raw.name)) {
        return fail([...path, 'name'], `Системный датасет — один из: ${SYSTEM_DATASETS.join(', ')}`)
      }
      source = { kind, name: raw.name, ...withAlias }
    } else {
      if (typeof raw.id !== 'string' || !UUID.test(raw.id)) {
        return fail([...path, 'id'], 'Нужен идентификатор источника')
      }
      source = { kind, id: raw.id, ...withAlias }
    }
    let relation = this.host.source(source, path)
    if (raw.filter !== undefined) relation = this.filterTarget(relation, raw.filter, path)
    const field = raw.field
    if (field !== undefined && typeof field !== 'string') {
      fail([...path, 'field'], 'Поле геометрии цели — строкой')
    }
    const geom = geometryColumn(relation, field, [...path, 'field'], 'цели')
    return { kind: 'relation', relation, geom }
  }

  /** Территории справочника: по идентификаторам и (или) уровню; граница — поле `geom`. */
  protected territoryTarget(raw: Record<string, unknown>, path: IssuePath): Target {
    allowedKeys(raw, ['kind', 'id', 'ids', 'level'], path)
    if (raw.id !== undefined && raw.ids !== undefined) {
      fail([...path, 'ids'], 'Укажите id или ids, но не оба')
    }
    const idsPath = raw.id !== undefined ? [...path, 'id'] : [...path, 'ids']
    const list = raw.id !== undefined ? [raw.id] : raw.ids
    let ids: string[] | null = null
    if (list !== undefined) {
      if (!Array.isArray(list) || list.length === 0 || list.length > MAX_TERRITORIES) {
        fail(idsPath, `Территории — непустой список идентификаторов (до ${MAX_TERRITORIES})`)
      }
      list.forEach((id, index) => {
        if (typeof id !== 'string' || !UUID.test(id)) {
          fail(
            raw.id !== undefined ? idsPath : [...idsPath, index],
            'Нужен идентификатор территории',
          )
        }
      })
      ids = list as string[]
    }
    const level = raw.level
    if (level !== undefined && !(TERRITORY_LEVELS as readonly unknown[]).includes(level)) {
      fail([...path, 'level'], `Уровень — один из: ${TERRITORY_LEVELS.join(', ')}`)
    }
    if (ids === null && level === undefined) {
      fail(path, 'Для цели-территорий нужны id, ids или level')
    }
    const conditions: FilterNode[] = []
    if (ids) conditions.push({ field: 'id', op: 'in', value: ids })
    if (level !== undefined) conditions.push({ field: 'level', op: 'eq', value: level })
    const relation = this.filterTarget(
      this.territories(path),
      conditions.length === 1 ? conditions[0] : { and: conditions },
      path,
    )
    return { kind: 'relation', relation, geom: directoryColumn(relation, 'geom', path) }
  }

  /** Справочник территорий — системный датасет с правами смотрящего. */
  protected territories(path: IssuePath): Relation {
    return this.host.source({ kind: 'system', name: TERRITORIES_DATASET }, path)
  }

  /** Условие на цель — отдельным CTE над её источником. */
  protected filterTarget(relation: Relation, raw: unknown, path: IssuePath): Relation {
    const parsed = FilterNode.safeParse(raw)
    if (!parsed.success) return fail([...path, 'filter'], 'Условие цели — в формате фильтра')
    const condition = compileFilter(
      this.state,
      parsed.data,
      {
        field: (ref, fieldPath) => {
          const column = resolveColumn(relation, ref, fieldPath)
          return {
            sql: columnSql(this.d, relation, column),
            type: column.type,
            fieldType: column.meta.fieldType,
          }
        },
      },
      [...path, 'filter'],
    )
    if (condition === null) return relation
    const name = this.state.nextName('j')
    this.state.addCte(name, `SELECT *\nFROM ${this.ref(relation)}\nWHERE ${condition}`)
    return { ...relation, name }
  }

  /** Пространственное отношение `a` к `b` (a — строка данных, b — цель). */
  protected relate(predicate: Predicate, a: string, b: string, distance: string | null): string {
    switch (predicate) {
      case 'intersects':
        return `ST_Intersects(${a}, ${b})`
      case 'within':
        return `ST_Within(${a}, ${b})`
      case 'contains':
        return `ST_Contains(${a}, ${b})`
      case 'dwithin':
        return `ST_DWithin(${this.geography(a)}, ${this.geography(b)}, ${distance})`
    }
  }
}
