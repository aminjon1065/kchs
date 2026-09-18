import type { InboxKind } from '@kchs/contracts'
import type { UserCtx } from '~/shared/context.js'

/** Элемент Входящих, над которым выполняется действие. */
export interface InboxActionItem {
  id: string
  kind: InboxKind
  objectId: string | null
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
