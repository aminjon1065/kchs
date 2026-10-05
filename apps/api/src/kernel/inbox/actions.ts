import type { DelegationScope, InboxItem, InboxKind } from '@kchs/contracts'
import type { UserCtx } from '~/shared/context.js'

/** Элемент Входящих, над которым выполняется действие. */
export interface InboxActionItem {
  id: string
  kind: InboxKind
  objectId: string | null
  /** Шаг маршрута, который открыл элемент (ADR-0079). */
  processStepId: string | null
  userId: string
  /** Копия заместителю: действие выполняется от имени этого пользователя. */
  onBehalfOf: string | null
  payload: Record<string, unknown>
}

export interface InboxActionRequest {
  item: InboxActionItem
  action: string
  comment?: string
  payload?: Record<string, unknown>
}

/**
 * Исполнитель действий элементов одного вида. Модуль, который открывает
 * элементы (поручения, согласования), выполняет их кнопки: из Входящих,
 * из Telegram, из уведомления — одним путём (12-calendar-notifications-home.md §3).
 * Элемент закрывает само доменное действие, а не вызывающий код.
 */
export type InboxActionHandler = (ctx: UserCtx, request: InboxActionRequest) => Promise<void>

const handlers = new Map<InboxKind, InboxActionHandler>()

export function registerInboxActionHandler(kind: InboxKind, handler: InboxActionHandler): void {
  if (handlers.has(kind)) throw new Error(`Действия Входящих вида «${kind}» уже зарегистрированы`)
  handlers.set(kind, handler)
}

export function inboxActionHandler(kind: InboxKind): InboxActionHandler | undefined {
  return handlers.get(kind)
}

/** Вид дела Входящих глазами ядра (ADR-0182): ядро не знает видов модулей по именам. */
export interface InboxKindOptions {
  /** Кнопки по умолчанию — если открывший элемент не передал свои. */
  actions?: InboxItem['actions']
  /** Области замещения, кроме `all`, которые распространяются на дела этого вида. */
  delegationScopes?: Exclude<DelegationScope, 'all'>[]
}

const kinds = new Map<InboxKind, InboxKindOptions>()

/** Вид дела объявляет его модуль (или механизм ядра) при старте, в любой роли процесса. */
export function registerInboxKind(kind: InboxKind, options: InboxKindOptions): void {
  if (kinds.has(kind)) throw new Error(`Вид дела Входящих «${kind}» уже объявлен`)
  kinds.set(kind, options)
}

export function inboxKind(kind: InboxKind): InboxKindOptions | undefined {
  return kinds.get(kind)
}
