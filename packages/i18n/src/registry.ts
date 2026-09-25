import type { Dictionary } from './locales/ru.js'
import type { Locale } from './resources.js'
import type { DeepPartial } from './types.js'

/**
 * Загруженные словари. Серверный вход (`index.ts`) регистрирует все языки сразу;
 * вход браузера (`browser.ts`) — только основной `ru`, остальные догружает
 * `loadLocale()` отдельными чанками (ADR-0166).
 */
const loaded = new Map<Locale, DeepPartial<Dictionary>>()

export function registerLocale(locale: Locale, dictionary: DeepPartial<Dictionary>): void {
  loaded.set(locale, dictionary)
}

export function localeDictionary(locale: Locale): DeepPartial<Dictionary> | undefined {
  return loaded.get(locale)
}

/** Загружен ли словарь языка: до загрузки переводчик отвечает на основном языке. */
export function isLocaleLoaded(locale: Locale): boolean {
  return loaded.has(locale)
}
