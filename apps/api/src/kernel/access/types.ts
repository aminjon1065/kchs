import type { AccessReason, Capability, Decision, Level } from '@kchs/contracts'
import type { SQL } from 'drizzle-orm'
import type { UserCtx } from '~/shared/context.js'

export type { AccessReason, Decision, Level }

/** Строка реестра объектов в упрощённом виде для политик. */
export interface ObjectLike {
  id: string
  type: string
  spaceId: string | null
  parentId: string | null
  ownerId: string | null
  accessMode: string
  archivedAt: string | null
  deletedAt: string | null
  meta: Record<string, unknown>
  title: string
}

/**
 * Политика типа объекта — производные права из отношений
 * (03-access-model.md, источник прав №5).
 */
export interface TypePolicy {
  /**
   * Возвращает уровень, который тип даёт пользователю из отношений
   * (исполнитель поручения, участник согласования, руководитель…).
   */
  derive?: (ctx: UserCtx, object: ObjectLike) => Promise<{ level: Level; reason: AccessReason }[]>
  /**
   * SQL-предикат для списков: `objects.id IN (…)` или условие по `meta`.
   * Должен возвращать `null`, если тип не добавляет видимости сверх общих правил.
   */
  visibleSql?: (ctx: UserCtx) => SQL | null
  /**
   * Атрибутные ограничения, которые могут только понижать уровень
   * (гриф конфиденциальности, территории пользователя).
   */
  cap?: (ctx: UserCtx, object: ObjectLike) => Promise<{ level: Level; reason: AccessReason } | null>
}

export interface ActionDefinition {
  minLevel: Level
  capability?: Capability
  /** Действие запрещено для архивных объектов (по умолчанию true для изменяющих). */
  allowArchived?: boolean
}

export interface AuthorizeOptions {
  /** Уже загруженная строка объекта — чтобы не читать повторно. */
  object?: ObjectLike
  /** Не выбрасывать, а вернуть решение. */
  soft?: boolean
  /** Разрешить действие над объектом в корзине (восстановление, окончательное удаление). */
  allowTrashed?: boolean
}
