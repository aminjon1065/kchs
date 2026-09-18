import type { FieldType, Level, ObjectSummary, ObjectType, SearchDocument } from '@kchs/contracts'
import type { SQL } from 'drizzle-orm'
import type { Ctx, UserCtx } from '~/shared/context.js'
import type { Executor } from '~/shared/db/client.js'
import type { ActionDefinition, ObjectLike, TypePolicy } from '../access/types.js'

/**
 * Поле списка объектов: как его фильтровать и сортировать в SQL
 * (02-platform-kernel.md §13 — «модули описывают схему фильтруемых полей типа»).
 * Выражение строится над строкой `objects`; поля модуля обычно читают `objects.meta`.
 */
export interface ListFieldDef {
  key: string
  labelKey: string
  type: FieldType
  sql: SQL
  sortable?: boolean
  options?: Array<{ value: string; labelKey: string }>
}

/**
 * Описание типа объекта, которое модуль регистрирует при старте
 * (02-platform-kernel.md §1). Ядро не знает о типах ничего сверх этого.
 */
export interface ObjectTypeDefinition {
  type: ObjectType
  /** Ключ i18n подписи типа: `objects.types.<type>`. */
  labelKey: string
  /** Имя иконки Lucide. */
  icon: string
  /** URL вкладки объекта в веб-клиенте. */
  route: (id: string, params?: Record<string, string>) => string
  /** Уровни, имеющие смысл для типа (для диалога «Поделиться»). */
  levels: Level[]
  /** Действия модуля: минимальный уровень и, при необходимости, способность. */
  actions: Record<string, ActionDefinition>
  policy?: TypePolicy
  /** Как индексировать объект; `null` — не индексировать. */
  searchable?: (id: string) => Promise<SearchDocument | null>
  /** Поля списков этого типа сверх общих: фильтры и сортировка CollectionView. */
  listFields?: ListFieldDef[]
  /** Дополнение сводки для карточек, пикеров и чипов. */
  summary?: (ids: string[]) => Promise<Map<string, Partial<ObjectSummary>>>
  lifecycle?: {
    onArchive?: (tx: Executor, ctx: Ctx, object: ObjectLike) => Promise<void>
    onRestore?: (tx: Executor, ctx: Ctx, object: ObjectLike) => Promise<void>
    onDelete?: (tx: Executor, ctx: Ctx, object: ObjectLike) => Promise<void>
    onMove?: (
      tx: Executor,
      ctx: Ctx,
      object: ObjectLike,
      from: { spaceId: string | null; parentId: string | null },
    ) => Promise<void>
  }
  discussable: boolean
  linkable: boolean
  hasParentTree: boolean
  /** Тип создаётся только ядром/системой (например, `conversation`). */
  internal?: boolean
}

const registry = new Map<string, ObjectTypeDefinition>()

export function registerObjectType(definition: ObjectTypeDefinition): void {
  if (registry.has(definition.type)) {
    throw new Error(`Тип объекта «${definition.type}» уже зарегистрирован`)
  }
  registry.set(definition.type, definition)
}

export function objectType(type: string): ObjectTypeDefinition | undefined {
  return registry.get(type)
}

export function requireObjectType(type: string): ObjectTypeDefinition {
  const definition = registry.get(type)
  if (!definition) throw new Error(`Тип объекта «${type}» не зарегистрирован`)
  return definition
}

export function listObjectTypes(): ObjectTypeDefinition[] {
  return [...registry.values()]
}

export function clearObjectTypes(): void {
  registry.clear()
}

/** Описание действия типа: `dataset.export`, `file.download`. */
export function actionDefinition(type: string, action: string): ActionDefinition | undefined {
  const definition = registry.get(type)
  if (!definition) return undefined
  // действие может быть записано как `type.action` или просто `action`
  const short = action.startsWith(`${type}.`) ? action.slice(type.length + 1) : action
  return definition.actions[action] ?? definition.actions[short]
}

/** Разрешённые пользователю действия для карточки объекта. */
export function allowedActions(
  type: string,
  level: Level,
  ctx: UserCtx,
  levelValue: (l: Level) => number,
): string[] {
  const definition = registry.get(type)
  if (!definition) return []
  const current = levelValue(level)
  return Object.entries(definition.actions)
    .filter(([, def]) => {
      if (levelValue(def.minLevel) > current) return false
      if (def.capability && !ctx.capabilities.has(def.capability)) return false
      return true
    })
    .map(([key]) => (key.includes('.') ? key : `${type}.${key}`))
}
