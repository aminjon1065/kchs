import { AsyncLocalStorage } from 'node:async_hooks'

/** Какое событие и каким подписчиком сейчас обрабатывается (ADR-0171). */
export interface EventDelivery {
  subscriber: string
  eventId: string
}

const storage = new AsyncLocalStorage<EventDelivery>()

/**
 * Обработка события подписчиком. Доставка — «как минимум один раз»: после сбоя
 * посреди обработки событие придёт снова, и побочные эффекты, которые нельзя
 * повторять (уведомление, письмо, Telegram), узнают повтор по этому контексту.
 */
export function withEventDelivery<T>(delivery: EventDelivery, run: () => Promise<T>): Promise<T> {
  return storage.run(delivery, run)
}

/** Текущая доставка события; вне обработки события — `undefined`. */
export function currentEventDelivery(): EventDelivery | undefined {
  return storage.getStore()
}
