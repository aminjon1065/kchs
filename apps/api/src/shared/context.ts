import type { AdminModeState, Capability, Confidentiality, Locale } from '@kchs/contracts'

/**
 * Множество принципалов пользователя (03-access-model.md).
 * Ключи в форме `type:id`; вычисляется при входе, кэшируется в Redis.
 */
export interface PrincipalSet {
  /**
   * Ключи `user:…`, `group:…`, `unit:…`, `position:…`, `space:<id>:<role>`, `role:…`,
   * `everyone`, `acting_as:…` (замещение) и `unit_head:…` (возглавляемые подразделения).
   */
  keys: string[]
  userId: string
  groupIds: string[]
  /** Подразделения пользователя и все их предки. */
  unitIds: string[]
  primaryUnitId: string | null
  /**
   * Территории ответственности: у своих подразделений — территория подразделения
   * или ближайшего предка, где она задана (`@my_territories`, ADR-0057).
   */
  territoryIds: string[]
  positionIds: string[]
  /** Пространство → роль участника. */
  spaceRoles: Record<string, string>
  roleKeys: string[]
  /** Активные замещения: пользователи, от имени которых можно действовать. */
  actingFor: Array<{ userId: string; scope: string }>
  /** Подразделения, которые пользователь возглавляет (ключи `unit_head:<id>`). */
  headedUnitIds: string[]
  version: number
}

export interface UserCtx {
  kind: 'user'
  userId: string
  sessionId: string
  displayName: string
  locale: Locale
  timezone: string
  principals: PrincipalSet
  capabilities: Set<Capability>
  roleKeys: string[]
  isSystemAdmin: boolean
  isSecurityAuditor: boolean
  /** Действие выполняется от имени другого пользователя (замещение). */
  onBehalfOf: string | null
  /** Гостевой доступ по ссылке: ограничен одним объектом. */
  shareLink: { token: string; objectId: string; includeAttachments: boolean } | null
  /**
   * Страница печати в Chromium движка (ADR-0078): служебный токен одного
   * запуска, права — того, под кем строится документ, только чтение.
   */
  print?: { scope: string } | null
  /**
   * Запрос пришёл с токеном публичного API (ADR-0097): права — владельца
   * токена, дополнительно ограниченные областями (`scopes`).
   */
  apiToken?: { id: string; name: string; scopes: string[] } | null
  requestId: string
  ip: string | null
  userAgent: string | null
  /** Пользовательские атрибуты для атрибутных ограничений (допуск, территории). */
  attributes: Record<string, unknown>
  /**
   * Допуск к грифам (атрибут `clearance`, ADR-0080): объекты строже него
   * недоступны независимо от прав. Гость по ссылке — только `public`.
   */
  clearance: Confidentiality
  /**
   * Режим администратора сессии (ADR-0080): администратор системы видит
   * объекты с грифом выше допуска, пока срок не вышел; всё — в аудит.
   */
  adminMode: AdminModeState | null
  /**
   * Временный пароль ещё не сменён: доступны только вход/выход, `GET /me`
   * и смена пароля (17-security.md §2).
   */
  mustChangePassword: boolean
  /**
   * Политика требует второй фактор для роли пользователя, а он не подключён:
   * доступны только профиль, подключение MFA и выход (17-security.md §2).
   */
  mfaEnrollmentRequired: boolean
}

/** Контекст фоновых заданий и внутренних вызовов. Всегда логируется. */
export interface SystemCtx {
  kind: 'system'
  reason: string
  requestId: string
  /** Инициатор, если задание порождено действием пользователя. */
  initiatorId: string | null
  locale: Locale
}

export type Ctx = UserCtx | SystemCtx

/** Режим администратора действует: администратор системы, срок не вышел. */
export function adminModeActive(ctx: Ctx): boolean {
  return (
    ctx.kind === 'user' &&
    ctx.isSystemAdmin &&
    ctx.adminMode !== null &&
    new Date(ctx.adminMode.until).getTime() > Date.now()
  )
}

export function actorId(ctx: Ctx): string | null {
  return ctx.kind === 'user' ? ctx.userId : ctx.initiatorId
}

export function systemCtx(reason: string, options?: Partial<SystemCtx>): SystemCtx {
  return {
    kind: 'system',
    reason,
    requestId: options?.requestId ?? `sys_${Math.random().toString(36).slice(2, 10)}`,
    initiatorId: options?.initiatorId ?? null,
    locale: options?.locale ?? 'ru',
  }
}

/**
 * Гость по ссылке: `userId` вида `link:<id>`, личного состояния нет
 * (избранное, недавние, подписки, прочитанность).
 */
export function isGuest(ctx: Ctx): boolean {
  return ctx.kind === 'user' && ctx.shareLink !== null
}

export const EMPTY_PRINCIPALS: PrincipalSet = {
  keys: [],
  userId: '',
  groupIds: [],
  unitIds: [],
  primaryUnitId: null,
  territoryIds: [],
  positionIds: [],
  spaceRoles: {},
  roleKeys: [],
  actingFor: [],
  headedUnitIds: [],
  version: 0,
}
