import { CORE_NAMESPACES, type Namespace } from './namespaces.js'
import type { Locale } from './resources.js'

/**
 * Загруженные словари — по языкам и неймспейсам (ADR-0191). Серверный вход (`index.ts`)
 * регистрирует всё сразу; вход браузера (`browser.ts`) — неймспейсы оболочки `ru`, остальное
 * догружает: язык — `loadLocale()`, неймспейсы модуля — `loadNamespaces()` (ADR-0166).
 */
const loaded = new Map<Locale, Map<string, object>>()

export function registerNamespaces(
  locale: Locale,
  dictionaries: { readonly [N in Namespace]?: object },
): void {
  let namespaces = loaded.get(locale)
  if (!namespaces) {
    namespaces = new Map()
    loaded.set(locale, namespaces)
  }
  for (const [namespace, dictionary] of Object.entries(dictionaries)) {
    if (dictionary) namespaces.set(namespace, dictionary)
  }
}

export function namespaceDictionary(locale: Locale, namespace: string): object | undefined {
  return loaded.get(locale)?.get(namespace)
}

export function isNamespaceLoaded(locale: Locale, namespace: string): boolean {
  return loaded.get(locale)?.has(namespace) ?? false
}

/** Загружены ли неймспейсы оболочки языка: до загрузки переводчик отвечает на основном языке. */
export function isLocaleLoaded(locale: Locale): boolean {
  return CORE_NAMESPACES.every((namespace) => isNamespaceLoaded(locale, namespace))
}

/**
 * Ключ из незагруженного неймспейса. Вход браузера ставит обработчик: он запускает загрузку
 * и отвечает `true` — переводчик тогда вернёт пустую строку, а не сырой ключ.
 */
let missingNamespace: ((locale: Locale, namespace: string) => boolean) | undefined

export function onMissingNamespace(handler: (locale: Locale, namespace: string) => boolean): void {
  missingNamespace = handler
}

export function handleMissingNamespace(locale: Locale, namespace: string): boolean {
  return missingNamespace?.(locale, namespace) ?? false
}

/**
 * Неймспейс, догруженный по ключу, которого ждал уже нарисованный текст: подписчики (`useT`
 * веба) перерисовываются. Загрузка, объявленная модулем, сюда не сообщает — экран и так ждёт её.
 */
const listeners = new Set<() => void>()
let version = 0

export function subscribeDictionaries(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function dictionariesVersion(): number {
  return version
}

export function notifyDictionaries(): void {
  version += 1
  for (const listener of listeners) listener()
}
