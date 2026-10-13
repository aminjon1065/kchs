import type { SqlDataset } from '../../types.js'
import { type Placeholder, type SourcePositions, sqlFail } from '../text.js'
import { NODE_FIELDS, UNSUPPORTED } from './grammar.js'
import {
  DatasetBinding,
  type DatasetRef,
  type Edit,
  isObj,
  list,
  type Obj,
  type Output,
  type TableCatalog,
} from './model.js'

/**
 * Слой 1: чтение дерева по белому списку и состояние анализа — правки текста,
 * датасеты, параметры, признаки времени и случайности.
 */
export abstract class TreeReader {
  readonly edits: Edit[] = []
  readonly datasets = new Map<string, { dataset: SqlDataset; refs: DatasetRef[] }>()
  readonly tables: string[] = []
  readonly systemColumns = new Set<string>()
  readonly params: Placeholder[] = []
  usesTime = false
  volatile = false
  protected readonly bindings = new Map<string, DatasetBinding>()
  protected readonly placeholders = new Map<number, Placeholder>()
  protected readonly seen = new Set<number>()
  /** ColumnRef, переписанный с подписи на ключ, — имя столбца Postgres возьмёт по ключу. */
  protected readonly renamed = new WeakMap<Obj, string>()
  /** Столбцы результата подзапросов-выражений — для имени `(SELECT …)`. */
  protected readonly sublinkOutputs = new WeakMap<Obj, Output[]>()
  protected cteCount = 0

  constructor(
    protected readonly text: string,
    protected readonly positions: SourcePositions,
    protected readonly catalog: TableCatalog | null,
    placeholders: readonly Placeholder[],
  ) {
    for (const placeholder of placeholders) this.placeholders.set(placeholder.start, placeholder)
  }

  protected at(location: unknown, fallback: number): number {
    return typeof location === 'number' && location >= 0
      ? this.positions.fromByte(location)
      : fallback
  }

  /** Узел `{Тип: поля}`; тип и поля проверяются по белому списку. */
  protected node(value: unknown, pos: number): [string, Obj] {
    if (isObj(value)) {
      const keys = Object.keys(value)
      if (keys.length === 1) {
        const type = keys[0] as string
        const fields = value[type]
        if (isObj(fields)) {
          this.check(type, fields, this.at(fields.location, pos))
          return [type, fields]
        }
      }
    }
    return sqlFail('Конструкция SQL не поддерживается', pos)
  }

  /** Поля узла — только из белого списка. */
  protected check(type: string, fields: Obj, pos: number): void {
    const allowed = NODE_FIELDS[type]
    if (!allowed) {
      const known = UNSUPPORTED[type]
      sqlFail(known ?? `Конструкция SQL «${type}» не поддерживается`, pos)
    }
    for (const key of Object.keys(fields)) {
      if (!allowed.includes(key)) sqlFail(`Конструкция SQL «${type}.${key}» не поддерживается`, pos)
    }
  }

  /** Узел содержит только перечисленные поля (у разных форм SELECT — разные наборы). */
  protected only(fields: Obj, allowed: readonly string[], pos: number): void {
    for (const key of Object.keys(fields)) {
      if (!allowed.includes(key)) sqlFail('Конструкция SQL не поддерживается', pos)
    }
  }

  /** Список строк (имена функций, операторов, типов, столбцов). */
  protected strings(value: unknown, pos: number): string[] {
    return list(value).map((item) => {
      const [type, fields] = this.node(item, pos)
      if (type !== 'String' || typeof fields.sval !== 'string') {
        return sqlFail('Конструкция SQL не поддерживается', pos)
      }
      return fields.sval
    })
  }

  protected binding(dataset: SqlDataset): DatasetBinding {
    let binding = this.bindings.get(dataset.id)
    if (!binding) {
      binding = new DatasetBinding(dataset)
      this.bindings.set(dataset.id, binding)
    }
    return binding
  }
}
