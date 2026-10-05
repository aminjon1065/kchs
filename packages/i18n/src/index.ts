import { en } from './locales/en/index.js'
import { ru } from './locales/ru/index.js'
import { tg } from './locales/tg/index.js'
import type { Namespace } from './namespaces.js'
import { registerNamespaces } from './registry.js'
import type { Locale } from './resources.js'

/**
 * Серверный вход (условие `default`): сервер, скрипты и тесты держат все языки и неймспейсы
 * сразу — письма и уведомления уходят на языке получателя. Загружать нечего.
 */
registerNamespaces('ru', ru)
registerNamespaces('tg', tg)
registerNamespaces('en', en)

export function loadLocale(_locale: Locale): Promise<void> {
  return Promise.resolve()
}

export function loadNamespaces(_locale: Locale, _namespaces: readonly Namespace[]): Promise<void> {
  return Promise.resolve()
}

export * from './namespaces.js'
export {
  dictionariesVersion,
  isLocaleLoaded,
  isNamespaceLoaded,
  subscribeDictionaries,
} from './registry.js'
export * from './resources.js'
export * from './translate.js'
export type { DeepPartial, TranslateParams } from './types.js'
