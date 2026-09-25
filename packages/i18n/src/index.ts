import { en } from './locales/en.js'
import { ru } from './locales/ru.js'
import { tg } from './locales/tg.js'
import { registerLocale } from './registry.js'
import type { Locale } from './resources.js'

/**
 * Словари интерфейса: вложенные ключи `module.screen.element`. Их читает
 * собственный переводчик (`translate.ts`) — один и тот же на сервере
 * (уведомления, письма) и в клиенте (ADR-0037). Сервер, скрипты и тесты
 * получают все языки сразу: письмо уходит на языке получателя. Браузер
 * берёт вход `browser.ts` — там в бандле только `ru` (ADR-0166).
 */
registerLocale('ru', ru)
registerLocale('tg', tg)
registerLocale('en', en)

/** Все словари уже загружены — ждать нечего; в браузере язык догружается. */
export function loadLocale(_locale: Locale): Promise<void> {
  return Promise.resolve()
}

export { isLocaleLoaded } from './registry.js'
export * from './resources.js'
export * from './translate.js'
export type { DeepPartial, TranslateParams } from './types.js'
