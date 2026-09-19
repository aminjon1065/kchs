import type { AccessReason, Capability, Confidentiality, Decision, Level } from '@kchs/contracts'
import type { SQL } from 'drizzle-orm'
import type { UserCtx } from '~/shared/context.js'
import type { Executor } from '~/shared/db/client.js'

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
  /** Свой гриф объекта (ADR-0080); вложению добавляется гриф объектов-хостов. */
  confidentiality: Confidentiality
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
  /**
   * Принципалы, которым политика открывает объект на просмотр (`user:<id>` —
   * участникам шагов маршрута, ADR-0079; `unit_head:<id>` — руководителям
   * исполнителя поручения, ADR-0082). Ядро добавляет их к читателям объекта:
   * фильтр поиска и системные датасеты видят то же, что `derive` и `visibleSql`.
   */
  principals?: (object: ObjectLike, executor: Executor) => Promise<string[]>
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
